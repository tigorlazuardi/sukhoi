# Sukhoi - Autonomous Coding Agent

Plane webhook listener yang menerima issue state changes, menjalankan AI coding agent via OpenCode, dan membuat pull request.

## Arsitektur

```
Plane (self-hosted)
  │
  │ Webhook POST (issue.update, state → Todo)
  │ Headers: X-Plane-Signature, X-Plane-Event
  ▼
┌──────────────────────────────────────────┐
│  sukhoi (Node.js service)                │
│                                          │
│  1. Verify X-Plane-Signature             │
│  2. Filter: hanya state → Todo           │
│  3. Fetch issue detail dari              │
│     Plane API (description,              │
│     labels, parent, priority)            │
│  4. Classify complexity (optional)       │
│     cheap LLM → boilerplate/typical/     │
│     complex                              │
│  5. Route model via sukhoi.config.json   │
│     priority+label+complexity            │
│     → provider/model                     │
│  6. Spawn Docker container               │
│     pass MODEL sebagai env var           │
│  7. Update Plane state                   │
│     → In Progress / Review               │
└──────────────────┬───────────────────────┘
                   │
                   │ docker run sukhoi-runner
                   │   -e MODEL=anthropic/claude-sonnet-4-20250514
                   ▼
┌──────────────────────────────────────────┐
│  sukhoi-runner (Docker image)            │
│                                          │
│  - Node.js 22                            │
│  - pnpm                                  │
│  - git + gh CLI                          │
│  - wrangler (Cloudflare)                 │
│  - opencode CLI                          │
│                                          │
│  Lifecycle:                              │
│  1. git clone repo                       │
│  2. git checkout -b branch               │
│  3. pnpm install                         │
│  4. opencode cli --model $MODEL          │
│     --prompt "solve issue..."            │
│  5. pnpm typecheck (verify)              │
│  6. git push + gh pr create              │
│  7. exit                                 │
└──────────────────────────────────────────┘
```

Model selection terjadi di sukhoi (Node.js service), bukan di runner.
Runner hanya terima `MODEL` env var berisi `provider/model` string
(format sama seperti OpenCode GitHub Action: `anthropic/claude-sonnet-4-20250514`).

## Komponen

### 1. Webhook Server (`src/`)

Node.js HTTP server yang:
- Listen POST `/webhook`
- Verify `X-Plane-Signature` via HMAC SHA256
- Parse event, filter hanya `issue` event yang state berubah ke "Todo"
- Enqueue task ke job queue (in-memory atau Redis)

### 2. Job Processor (`src/`)

Worker yang:
- Dequeue task
- Update Plane state → "In Progress"
- Tentukan model (routing rules dari config)
- Spawn Docker container `sukhoi-runner` dengan env vars termasuk `MODEL`
- Tunggu container selesai
- Update Plane state → "Review/Testing" (sukses) atau → "Todo" (gagal)

### 3. Runner Image (`Dockerfile.runner`)

Docker image berisi semua dependency untuk kerjakan Cloudflare project:
- Node.js 22 LTS
- pnpm
- git
- GitHub CLI (gh)
- wrangler (Cloudflare CLI)
- OpenCode CLI

### 4. Classifier (`src/classifier.ts`)

Optional step: pakai cheap LLM (Haiku/Flash) untuk classify kompleksitas task
sebelum routing. Hanya dipanggil kalau routing rules menggunakan `complexity` match.

```
Input:  issue title + description (plaintext)
Output: "boilerplate" | "typical" | "complex"
Cost:   ~$0.001 per classification
```

Classifier prompt (hardcoded, tidak perlu customizable):
```
Classify this software engineering task into exactly one category.

- boilerplate: Repetitive/standard code. CRUD endpoints, config files,
  simple UI components, adding fields to existing patterns.
- typical: Standard SWE work. Implementing a well-defined feature,
  API endpoint with business logic, database queries, unit tests.
- complex: Requires architectural thinking. Multi-step flows (onboarding,
  checkout), security-critical features (auth, payment), data migrations,
  system design decisions.

Task title: {title}
Task description: {description}

Reply with exactly one word: boilerplate, typical, or complex.
```

Classifier dipanggil via Anthropic/OpenAI SDK langsung — bukan lewat OpenCode CLI.
Ini API call ringan, bukan coding agent session.

### 5. Model Router (`src/router.ts`)

Config-driven routing via `sukhoi.config.json`.
User define models dan routing rules. Output routing adalah `provider/model` string
yang compatible dengan OpenCode CLI `--model` flag.

```jsonc
// sukhoi.config.json
{
  "repo": "https://github.com/user/booth9.git",
  "baseBranch": "main",

  "prompt": "You are an autonomous coding agent. You are given a task from a project management system. Your job:\n\n1. Read the task description carefully.\n2. Explore the codebase to understand existing patterns and conventions.\n3. Implement the required changes with minimal, focused modifications.\n4. Ensure code quality — run `pnpm typecheck` before finishing.\n5. Only modify files relevant to the task. Do not refactor unrelated code.\n\nThe task will be provided below with its full context.",

  // Classifier: cheap LLM untuk tentukan complexity sebelum routing.
  // Hanya dipanggil kalau ada routing rule yang pakai "complexity" match.
  // Kalau tidak ada rule yang pakai complexity, classifier di-skip entirely.
  "classifier": {
    "model": "haiku",
    "enabled": true
  },

  "models": {
    "opus":   "anthropic/claude-opus-4-20250901",
    "sonnet": "anthropic/claude-sonnet-4-20250514",
    "haiku":  "anthropic/claude-haiku",
    "codex":  "openai/codex-mini-latest",
    "glm":    "openrouter/thudm/glm-4-32b"
  },
  "routing": [
    // Layer 1: Rule-based overrides (priority + label).
    // Ini dicek duluan. Kalau match, classifier tidak dipanggil.
    {
      "name": "critical-by-label",
      "match": {
        "priority": ["urgent"],
        "labels": ["auth", "payment"]
      },
      "model": "opus"
    },

    // Layer 2: Complexity-based (dari LLM classifier).
    // Classifier hanya dipanggil kalau rule di atas tidak match.
    {
      "name": "complex-tasks",
      "match": { "complexity": ["complex"] },
      "model": "opus"
    },
    {
      "name": "typical-tasks",
      "match": { "complexity": ["typical"] },
      "model": "sonnet"
    },
    {
      "name": "boilerplate-tasks",
      "match": { "complexity": ["boilerplate"] },
      "model": "haiku"
    }
  ],
  "defaultModel": "sonnet"
}
```

### Config fields

| Field | Keterangan |
|-------|-----------|
| `repo` | Git clone URL target repository |
| `baseBranch` | Branch asal untuk checkout branch baru (default: `"main"`) |
| `prompt` | System/operation prompt — instruksi cara kerja agent. Ini bukan task-nya, tapi _bagaimana_ agent harus bekerja. Di-concat dengan task context saat runtime. |
| `classifier` | Config untuk LLM classifier. `model`: alias dari `models`. `enabled`: on/off. |
| `models` | Alias → `provider/model` string (format OpenCode) |
| `routing` | Rules untuk pilih model berdasarkan issue data. Support match: `priority`, `labels`, `complexity`. |
| `defaultModel` | Fallback model kalau tidak ada rule yang match |

### Prompt architecture

Prompt yang dikirim ke OpenCode terdiri dari 2 bagian yang di-concat:

```
┌─────────────────────────────────────────────┐
│ config.prompt (dari sukhoi.config.json)     │
│                                             │
│ "You are an autonomous coding agent..."     │
│ Cara kerja, konvensi, constraints.          │
│ Sama untuk semua task.                      │
│ User bisa customize.                        │
└─────────────────────────────────────────────┘
                    +
┌─────────────────────────────────────────────┐
│ Task context (generated per-issue)          │
│                                             │
│ Issue: BOOTH9-42                            │
│ Title: Implement JWT validation middleware  │
│ Description: ...                            │
│ Labels: [middleware, auth]                  │
│ Parent: P3 - Auth Middleware Chain          │
│ Priority: urgent                            │
└─────────────────────────────────────────────┘
```

### Operation lifecycle

Ini yang entrypoint.sh lakukan — bukan bagian dari prompt, tapi hardcoded di runner script.
Configurable values (repo, baseBranch) diambil dari config dan dipass sebagai env vars.

```
1. git clone $REPO                      ← config.repo
2. git checkout -b fix/BOOTH9-42        ← dari issue data
   dari base $BASE_BRANCH               ← config.baseBranch
3. pnpm install
4. opencode cli --model $MODEL --prompt "$PROMPT"
5. pnpm typecheck
6. git add -A && git commit
7. git push origin fix/BOOTH9-42
8. gh pr create --base $BASE_BRANCH
9. Output: commit URL + PR URL          ← dikembalikan ke sukhoi service
```

Setelah runner selesai, sukhoi service:
- Update Plane issue state → "Review/Testing"
- Tambahkan comment di Plane issue berisi:
  - Summary apa yang dikerjakan
  - Link ke commit di GitHub
  - Link ke pull request

Format model value: `provider/model-id` — sama persis seperti OpenCode GitHub Action.
Ini berarti sukhoi bisa pakai model dari provider manapun yang OpenCode support
(Anthropic, OpenAI, OpenRouter, Google, dll) tanpa ubah code.

Routing logic:
- Rules dievaluasi urut dari atas ke bawah
- Match conditions:
  - `match.priority` — issue priority harus salah satu dari list (OR)
  - `match.labels` — issue harus punya minimal satu label dari list (OR)
  - `match.complexity` — hasil classifier harus salah satu dari list (OR)
- Kalau rule punya >1 condition, semuanya harus match (AND)
- First match wins — rule pertama yang cocok menentukan model
- Kalau tidak ada yang match → pakai `defaultModel`

Classifier optimization:
- Classifier hanya dipanggil **lazy** — saat pertama kali ada rule yang butuh `complexity`
- Kalau rule tanpa `complexity` sudah match duluan, classifier tidak dipanggil
- Ini berarti task yang jelas urgent+auth langsung ke Opus tanpa biaya classifier

API keys untuk tiap provider disimpan di `.env`:
```bash
ANTHROPIC_API_KEY=sk-ant-...   # untuk anthropic/*
OPENAI_API_KEY=sk-...          # untuk openai/*
OPENROUTER_API_KEY=sk-or-...   # untuk openrouter/*
```
Semua dipass ke runner container sebagai env vars.
OpenCode CLI otomatis pick API key yang sesuai berdasarkan provider.
