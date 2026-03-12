# Actionable Tasks

## Phase 1: Docker Runner Image

### T1.1 - Buat `Dockerfile.runner`
```
FROM node:22-slim

# System deps
RUN apt-get update && apt-get install -y git curl

# pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh

# Wrangler (Cloudflare)
RUN npm install -g wrangler

# OpenCode CLI
RUN npm install -g @anthropic-ai/opencode

WORKDIR /workspace
COPY runner/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

### T1.2 - Buat runner entrypoint script
Script yang dijalankan di dalam container.
Menerima env vars dari sukhoi service:
- Dari config: `REPO_URL`, `BASE_BRANCH`, `MODEL`, `PROMPT`
- Dari issue:  `BRANCH_NAME`, `ISSUE_ID`, `ISSUE_TITLE`, `PR_BODY`
- Credentials: `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, dll

```bash
#!/bin/bash
set -euo pipefail

# 1. Auth GitHub
echo "$GITHUB_TOKEN" | gh auth login --with-token
gh auth setup-git

# 2. Clone + branch dari base branch (configurable)
git clone "$REPO_URL" /workspace/repo
cd /workspace/repo
git checkout "$BASE_BRANCH"
git checkout -b "$BRANCH_NAME"

# 3. Install deps
pnpm install --frozen-lockfile

# 4. Run OpenCode dengan model yang dipilih oleh router
#    PROMPT sudah di-concat oleh sukhoi service: config.prompt + task context
opencode cli \
  --model "$MODEL" \
  --prompt "$PROMPT"

# 5. Verify
pnpm typecheck

# 6. Commit + push + PR
git add -A
git commit -m "fix: resolve $ISSUE_ID" || { echo "No changes"; exit 0; }
git push origin "$BRANCH_NAME"

PR_URL=$(gh pr create \
  --title "fix: $ISSUE_TITLE" \
  --body "$PR_BODY" \
  --base "$BASE_BRANCH")

COMMIT_URL=$(git log -1 --format="$REPO_URL/commit/%H" | sed 's/\.git//')

# 7. Output results as JSON untuk sukhoi service
echo "{\"pr_url\": \"$PR_URL\", \"commit_url\": \"$COMMIT_URL\"}" > /workspace/result.json
```

Runner output `result.json` supaya sukhoi service bisa:
- Baca PR URL dan commit URL
- Post comment di Plane issue dengan links tersebut

### T1.3 - Build dan test image lokal
```bash
docker build -f Dockerfile.runner -t sukhoi-runner .
docker run --rm -e GITHUB_TOKEN=... -e ANTHROPIC_API_KEY=... sukhoi-runner
```

---

## Phase 2: Webhook Server

### T2.1 - Init Node.js project
```bash
mkdir -p src
npm init -y
npm install --save-dev typescript @types/node
```

### T2.2 - Implement signature verification
Berdasarkan Plane docs:
```
signature = HMAC-SHA256(secret, JSON.stringify(body))
compare dengan header X-Plane-Signature
```

### T2.3 - Implement webhook handler
```
POST /webhook
  → verify signature
  → parse body
  → filter: event === "issue" && action === "update"
  → cek apakah state berubah ke "Todo" (state UUID)
  → kalau ya, enqueue job
  → respond 200 OK segera (jangan blocking)
```

### T2.4 - Implement state detection
Perlu mapping state name → UUID.
Fetch dari Plane API saat startup:
```
GET /api/v1/workspaces/{slug}/projects/{id}/states/
```
Cache mapping: { "Todo": "c9944313-...", "In Progress": "92e51c00-...", ... }

---

## Phase 3: Job Processor

### T3.1 - Implement job queue
Mulai dengan in-memory queue (array + setInterval).
Nanti bisa upgrade ke Redis/BullMQ kalau perlu persistence.

### T3.2 - Implement job execution flow
```
1. Dequeue job
2. Plane API: update state → "In Progress"
3. Fetch issue detail (title, description, labels, parent, priority)
4. routeModel(issue, config):
   - Evaluasi rules top-down
   - Kalau rule tanpa complexity match duluan → skip classifier
   - Kalau ketemu rule dengan complexity → panggil classifier (lazy, ~$0.001)
   - Return "anthropic/claude-sonnet-4-20250514"
5. buildPrompt(config, issue) → config.prompt + task context
6. docker run sukhoi-runner dengan env:
   - MODEL=anthropic/claude-sonnet-4-20250514  ← dari router
   - PROMPT=<config.prompt + task context>      ← dari prompt builder
   - REPO_URL=<config.repo>
   - BASE_BRANCH=<config.baseBranch>
   - BRANCH_NAME, ISSUE_ID, ISSUE_TITLE, PR_BODY
   - GITHUB_TOKEN
   - ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY (semua dipass)
7. Tunggu exit code
8. Baca /workspace/result.json dari container (PR URL + commit URL)
9. Kalau sukses:
   - Plane API: update state → "Review/Testing"
   - Plane API: add comment di issue berisi:
     - Ringkasan: model yang dipakai, branch name
     - Link ke commit: https://github.com/user/repo/commit/abc123
     - Link ke PR: https://github.com/user/repo/pull/42
10. Kalau gagal:
   - Plane API: update state → "Todo"
   - Plane API: add comment dengan error message
```

### T3.3 - Implement concurrency control
- Satu job jalan di satu waktu (serial queue)
- Timeout per job: 10 menit
- Retry: tidak (kalau gagal, kembali ke Todo, manusia decide)

---

## Phase 4: Classifier + Model Router

### T4.1 - Buat `sukhoi.config.json`
Config file di root project. Berisi repo target, base branch, operation prompt,
classifier config, model definitions, dan routing rules.
Lihat `architecture.md` untuk contoh lengkap config.

### T4.2 - Implement config loader + validation
- Load `sukhoi.config.json` saat startup
- Validasi:
  - `repo` harus ada dan valid URL
  - `baseBranch` harus ada (default: "main")
  - `prompt` harus ada (ada default value kalau kosong)
  - Semua `model` reference di routing harus ada di `models`
  - `defaultModel` harus ada di `models`
- Watch file changes → hot reload tanpa restart service

### T4.3 - Implement classifier
Cheap LLM call untuk classify task complexity.
Dipanggil secara lazy oleh routing engine — hanya kalau dibutuhkan.

```typescript
// src/classifier.ts
// Direct API call via Anthropic SDK, bukan OpenCode CLI

async function classifyComplexity(
  issue: PlaneIssue,
  config: SukhoiConfig
): Promise<'boilerplate' | 'typical' | 'complex'> {

  const classifierModel = config.models[config.classifier.model]
  // e.g. "anthropic/claude-haiku"

  const response = await anthropic.messages.create({
    model: classifierModel.split('/')[1], // "claude-haiku"
    max_tokens: 10,
    messages: [{
      role: 'user',
      content: `Classify this software engineering task into exactly one category.

- boilerplate: Repetitive/standard code. CRUD endpoints, config files,
  simple UI components, adding fields to existing patterns.
- typical: Standard SWE work. Implementing a well-defined feature,
  API endpoint with business logic, database queries, unit tests.
- complex: Requires architectural thinking. Multi-step flows (onboarding,
  checkout), security-critical features (auth, payment), data migrations,
  system design decisions.

Task title: ${issue.name}
Task description: ${stripHtml(issue.description_html)}

Reply with exactly one word: boilerplate, typical, or complex.`
    }]
  })

  const result = response.content[0].text.trim().toLowerCase()
  if (['boilerplate', 'typical', 'complex'].includes(result)) {
    return result
  }
  return 'typical' // fallback
}
```

### T4.4 - Implement routing engine
Evaluates rules top-down. Classifier dipanggil lazy — hanya saat
pertama kali ketemu rule yang butuh `complexity` match.

```typescript
// src/router.ts

async function routeModel(
  issue: PlaneIssue,
  config: SukhoiConfig
): Promise<string> {

  let complexity: string | null = null  // lazy, belum di-classify

  for (const rule of config.routing) {
    const { priority, labels, complexity: complexityMatch } = rule.match

    const priorityOk = !priority || priority.includes(issue.priority)
    const labelsOk = !labels || issue.labels.some(l => labels.includes(l.name))

    // Lazy classify: hanya panggil LLM kalau rule ini butuh complexity
    let complexityOk = true
    if (complexityMatch) {
      if (complexity === null) {
        complexity = await classifyComplexity(issue, config)
      }
      complexityOk = complexityMatch.includes(complexity)
    }

    // Semua conditions yang ada di rule harus match (AND)
    const conditions = [
      priority ? priorityOk : null,
      labels ? labelsOk : null,
      complexityMatch ? complexityOk : null,
    ].filter(c => c !== null)

    if (conditions.length > 0 && conditions.every(Boolean)) {
      return config.models[rule.model]
    }
  }

  return config.models[config.defaultModel]
}
```

### T4.5 - Implement prompt builder
Concat `config.prompt` (operation prompt) dengan task context (dari Plane issue).
Output: satu string yang dikirim ke OpenCode `--prompt`.

```typescript
function buildPrompt(config: SukhoiConfig, issue: PlaneIssue): string {
  const taskContext = `
---
Task: ${issue.identifier}-${issue.sequence_id}
Title: ${issue.name}
Description:
${issue.description_html} // stripped to plaintext

Labels: ${issue.labels.map(l => l.name).join(', ')}
${issue.parent ? `Part of: ${issue.parent.name}` : ''}
Priority: ${issue.priority}
---`

  return `${config.prompt}\n\n${taskContext}`
}
```

Ini memisahkan dua concern:
- `config.prompt` = **HOW** — cara kerja agent (user customize di config)
- task context = **WHAT** — apa yang dikerjakan (generated per-issue dari Plane)

---

## Phase 5: Deployment

### T5.1 - Docker Compose untuk seluruh stack
```yaml
services:
  sukhoi:
    build: .
    ports:
      - "3000:3000"
    env_file: .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # untuk spawn runner
    restart: unless-stopped
```

### T5.2 - Setup di VPS
1. Install Docker
2. Clone sukhoi repo
3. Setup `.env` (PLANE_API_KEY, GITHUB_TOKEN, ANTHROPIC_API_KEY, WEBHOOK_SECRET)
4. `docker compose up -d`
5. Setup reverse proxy (caddy/nginx) untuk HTTPS
6. Register webhook URL di Plane settings

### T5.3 - Setup Plane webhook
- Plane → Settings → Webhooks → Add
- URL: `https://sukhoi.yourdomain.com/webhook`
- Events: Issue
- Simpan secret key → masukkan ke `.env` sebagai WEBHOOK_SECRET

---

## File Structure

```
sukhoi/
├── plans/
│   ├── architecture.md
│   └── tasks.md
├── src/
│   ├── index.ts          # HTTP server entry point
│   ├── webhook.ts        # Signature verify + event parsing
│   ├── queue.ts          # Job queue
│   ├── worker.ts         # Job processor (spawn docker)
│   ├── classifier.ts     # Cheap LLM complexity classifier
│   ├── router.ts         # Config-driven model routing (uses classifier)
│   ├── prompt.ts         # Prompt builder dari Plane data
│   ├── plane.ts          # Plane API client (update state, fetch detail)
│   └── config.ts         # Env vars, load sukhoi.config.json
├── runner/
│   ├── Dockerfile        # Runner image
│   └── entrypoint.sh     # Clone, AI, push, PR
├── sukhoi.config.json    # Model definitions + routing rules
├── Dockerfile            # Main service image
├── docker-compose.yml
├── package.json
├── tsconfig.json
└── .env.example
```

---

## Environment Variables

```bash
# Plane
PLANE_API_KEY=plane-api-key
PLANE_BASE_URL=https://plane.yourdomain.com
PLANE_WORKSPACE_SLUG=your-workspace
PLANE_PROJECT_ID=843806f5-9782-4fe8-86d9-249eebd911b8
WEBHOOK_SECRET=from-plane-webhook-setup

# GitHub
GITHUB_TOKEN=ghp_...

# AI (pass semua, runner pakai yang sesuai dengan provider di MODEL)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...

# Runtime
CONCURRENCY=1
JOB_TIMEOUT_MS=600000
```

---

## Urutan Kerja (Dependency)

```
T1.1 → T1.2 → T1.3  (runner image, bisa test standalone)
              ↓
T2.1 → T2.2 → T2.3 → T2.4  (webhook server)
              ↓
T3.1 → T3.2 → T3.3  (job processor, butuh T1 + T2)
              ↓
T4.1 → T4.2 → T4.3 → T4.4 → T4.5  (config, loader, classifier, router, prompt)
              ↓
T5.1 → T5.2 → T5.3  (deploy, butuh semua di atas)
```
