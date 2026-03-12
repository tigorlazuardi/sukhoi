# Sukhoi

Autonomous coding agent. Listens to Plane webhooks, runs AI coding tasks via OpenCode, and opens pull requests on GitHub.

## How it works

1. You move an issue to **Todo** in Plane
2. Sukhoi receives the webhook, classifies task complexity via a cheap LLM
3. Routes to the appropriate model (Opus / Sonnet / Haiku) based on `sukhoi.config.json`
4. Runs the OpenCode agent as a subprocess — clones the repo, implements the task, opens a PR
5. Updates the Plane issue state to **Review/Testing** and posts a comment with the PR link

---

## Prerequisites

- Docker and Docker Compose on your VPS
- A Plane instance with webhook support
- A GitHub personal access token (PAT) with `repo` and `workflow` scopes
- API keys for your AI provider (Anthropic, OpenAI, or OpenRouter)

---

## Setup

### 1. Clone this repo

```bash
git clone https://github.com/tigorlazuardi/sukhoi.git
cd sukhoi
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# Plane
PLANE_API_KEY=plane-api-key-here
PLANE_BASE_URL=https://plane.yourdomain.com
PLANE_WORKSPACE_SLUG=your-workspace-slug
PLANE_PROJECT_ID=your-project-uuid
WEBHOOK_SECRET=secret-from-plane-webhook-settings

# GitHub — PAT with repo + workflow scopes
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

# AI providers (add keys for providers you use in sukhoi.config.json)
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxx

# Optional
CONCURRENCY=1
JOB_TIMEOUT_MS=600000
```

### 3. Create your config file

`sukhoi.config.json` is **not** included in the Docker image — you must create it yourself.
It is mounted into the container at runtime and hot-reloaded on changes.

```bash
cp sukhoi.config.example.json sukhoi.config.json
```

Then edit `sukhoi.config.json` to point to your repo and define your routing rules:

```jsonc
{
  "repo": "https://github.com/your-org/your-repo.git",
  "baseBranch": "main",
  "prompt": "You are an autonomous coding agent...",
  "classifier": { "model": "haiku", "enabled": true },
  "models": {
    "opus":   "anthropic/claude-opus-4-20250901",
    "sonnet": "anthropic/claude-sonnet-4-20250514",
    "haiku":  "anthropic/claude-haiku-4-20250307"
  },
  "routing": [
    { "name": "complex-tasks",    "match": { "complexity": ["complex"] },     "model": "opus"   },
    { "name": "typical-tasks",    "match": { "complexity": ["typical"] },     "model": "sonnet" },
    { "name": "boilerplate-tasks","match": { "complexity": ["boilerplate"] }, "model": "haiku"  }
  ],
  "defaultModel": "sonnet"
}
```

> **Note:** If the file is missing, the container will fail to start with a clear error message.
> The config is hot-reloaded — changes take effect immediately without restarting the service.

### 4. (Optional) Configure OpenCode

If you want to pass MCP servers, custom model settings, or other OpenCode configuration, create an `opencode.json` file on your host:

```jsonc
{
  "mcp": {
    "servers": {
      "my-db": {
        "type": "local",
        "command": ["npx", "-y", "@modelcontextprotocol/server-postgres"],
        "env": {
          "DATABASE_URL": "postgres://user:pass@host/db"
        }
      }
    }
  }
}
```

Then mount it into the container and set the in-container path in `.env`:

```yaml
# docker-compose.yml volumes:
volumes:
  - /home/youruser/opencode.json:/opencode.json:ro
```

```bash
OPENCODE_CONFIG_PATH=/opencode.json
```

The file is copied to `~/.config/opencode/config.json` inside the container before each job runs. Changes take effect on the next job without any restart.

### 5. Start the service

```bash
docker compose up -d
```

Check logs:

```bash
docker compose logs -f sukhoi
```

### 6. Expose via reverse proxy (HTTPS required by Plane)

Plane webhooks require a publicly accessible HTTPS URL. Using Caddy:

```bash
# Install Caddy
apt install -y caddy

# /etc/caddy/Caddyfile
sukhoi.yourdomain.com {
    reverse_proxy localhost:3000
}

systemctl reload caddy
```

Or using nginx:

```nginx
server {
    listen 443 ssl;
    server_name sukhoi.yourdomain.com;
    # ... ssl config ...

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 7. Register the webhook in Plane

1. Plane → **Settings** → **Webhooks** → **Add webhook**
2. URL: `https://sukhoi.yourdomain.com/webhook`
3. Events: check **Issue**
4. Save — copy the secret
5. Paste the secret into your `.env` as `WEBHOOK_SECRET`
6. Restart: `docker compose restart sukhoi`

---

## Using GHCR images (recommended for production)

Instead of building locally, pull the pre-built image from GitHub Container Registry.

```bash
# Login to GHCR
echo $GITHUB_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin

# Set the image in your environment and start
SUKHOI_IMAGE=ghcr.io/tigorlazuardi/sukhoi:latest docker compose up -d
```

Or set `SUKHOI_IMAGE` in your `.env`:

```bash
SUKHOI_IMAGE=ghcr.io/tigorlazuardi/sukhoi:latest
```

---

## Updating

### If building locally

```bash
git pull
docker compose up -d --build
```

### If using GHCR images

```bash
docker compose pull
docker compose up -d
```

---

## Triggering a task

Move any Plane issue to **Todo**. Sukhoi will:

1. Classify the task complexity
2. Pick the model from your routing rules
3. Clone the repo, implement the task, open a PR
4. Post a comment on the Plane issue with the PR link
5. Move the issue to **Review/Testing**

---

## Configuration reference

### `sukhoi.config.json`

| Field | Type | Default | Description |
|---|---|---|---|
| `repo` | string | required | Git clone URL of the target repository |
| `baseBranch` | string | `"main"` | Branch to create new feature branches from |
| `prompt` | string | built-in | System prompt prepended to every task |
| `classifier.model` | string | `defaultModel` | Model alias to use for complexity classification |
| `classifier.enabled` | boolean | `true` | Set to `false` to skip classification and rely on rules only |
| `models` | object | required | Map of alias → `"provider/model"` string (OpenCode format) |
| `routing` | array | required | Ordered list of routing rules. First match wins. |
| `defaultModel` | string | required | Fallback model alias when no rule matches |
| `worklog.enabled` | boolean | `false` | Enable persistent work log across jobs |
| `worklog.maxEntries` | number | `20` | Max recent entries to keep in the worklog |

### Routing rule

```jsonc
{
  "name": "my-rule",        // identifier for logs
  "match": {
    "priority": ["urgent"], // optional: issue priority values (OR)
    "labels": ["auth"],     // optional: Plane label names (OR)
    "complexity": ["complex"] // optional: classifier output (OR)
  },
  "model": "opus"           // model alias from "models"
}
```

Multiple conditions in `match` are evaluated with **AND**.
Rules are evaluated top-down — first match wins.
The classifier is only called if a rule uses `complexity` and no earlier rule matched.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `PLANE_API_KEY` | yes | Plane API key |
| `PLANE_BASE_URL` | yes | Plane instance URL |
| `PLANE_WORKSPACE_SLUG` | yes | Workspace slug |
| `PLANE_PROJECT_ID` | yes | Project UUID |
| `WEBHOOK_SECRET` | yes | From Plane webhook settings |
| `GITHUB_TOKEN` | yes | PAT with `repo` + `workflow` scopes |
| `ANTHROPIC_API_KEY` | if using Anthropic models | |
| `OPENAI_API_KEY` | if using OpenAI models | |
| `OPENROUTER_API_KEY` | if using OpenRouter models | |
| `PORT` | no | HTTP port (default: `3000`) |
| `CONCURRENCY` | no | Max parallel jobs (default: `1`) |
| `JOB_TIMEOUT_MS` | no | Runner timeout in ms (default: `600000`) |
| `REPO_CACHE_DIR` | no | Repo cache path inside container (default: `/repo-cache`) |
| `OPENCODE_CONFIG_PATH` | no | In-container path to opencode config file (mount via volumes) |
| `SUKHOI_IMAGE` | no | GHCR image to use instead of building locally |
