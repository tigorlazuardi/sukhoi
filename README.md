# Sukhoi

Autonomous coding agent. Listens to Plane webhooks, runs AI coding tasks via OpenCode, and opens pull requests on GitHub.

## How it works

1. You move an issue to **Todo** in Plane
2. Sukhoi receives the webhook, classifies task complexity via a cheap LLM
3. Routes to the appropriate model (Opus / Sonnet / Haiku) based on `sukhoi.config.json`
4. Spawns a Docker container (`sukhoi-runner`) that clones the repo, runs OpenCode, and opens a PR
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
git clone https://github.com/your-org/sukhoi.git
cd sukhoi
```

### 2. Build the runner image

The runner image contains all tools needed to work on a Cloudflare/pnpm project.
This must be built on the VPS (or pulled from GHCR — see below).

```bash
docker build -f runner/Dockerfile -t sukhoi-runner:latest runner/
```

### 3. Configure environment

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

### 4. Create your config file

`sukhoi.config.json` is **not** included in the Docker image — you must create it yourself.
It is mounted into the container at runtime and hot-reloaded on changes.

```bash
cp sukhoi.config.json.example sukhoi.config.json
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
4. Save — download the secret CSV
5. Copy the secret into your `.env` as `WEBHOOK_SECRET`
6. Restart: `docker compose restart sukhoi`

---

## Using GHCR images (recommended for production)

Instead of building locally, pull pre-built images from GitHub Container Registry.

### Pull the latest images

```bash
# Login to GHCR
echo $GITHUB_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin

# Pull images
docker pull ghcr.io/your-org/sukhoi:latest
docker pull ghcr.io/your-org/sukhoi-runner:latest

# Tag runner image to the name sukhoi expects
docker tag ghcr.io/your-org/sukhoi-runner:latest sukhoi-runner:latest
```

### Use the GHCR image in docker-compose

Edit `docker-compose.yml` to use the pre-built image instead of building:

```yaml
services:
  sukhoi:
    image: ghcr.io/your-org/sukhoi:latest   # ← change this
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./sukhoi.config.json:/app/sukhoi.config.json:ro
    restart: unless-stopped
```

Then:

```bash
docker compose pull
docker compose up -d
```

---

## Updating

### If building locally

```bash
git pull
docker build -f runner/Dockerfile -t sukhoi-runner:latest runner/
docker compose up -d --build
```

### If using GHCR images

```bash
docker compose pull
docker tag ghcr.io/your-org/sukhoi-runner:latest sukhoi-runner:latest
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

To trigger manually (for testing):

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Plane-Signature: $(echo -n '{}' | openssl dgst -sha256 -hmac YOUR_SECRET | awk '{print $2}')" \
  -d '{}'
```

---

## Configuration reference

### `sukhoi.config.json`

| Field | Type | Default | Description |
|---|---|---|---|
| `repo` | string | required | Git clone URL of the target repository |
| `baseBranch` | string | `"main"` | Branch to create new feature branches from |
| `prompt` | string | built-in | System prompt prepended to every task. Defines how the agent should behave. |
| `classifier.model` | string | `defaultModel` | Model alias (from `models`) to use for complexity classification |
| `classifier.enabled` | boolean | `true` | Set to `false` to skip classification and rely on rules only |
| `models` | object | required | Map of alias → `"provider/model"` string (OpenCode format) |
| `routing` | array | required | Ordered list of routing rules. First match wins. |
| `defaultModel` | string | required | Fallback model alias when no rule matches |

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
| `RUNNER_IMAGE` | no | Runner image name (default: `sukhoi-runner:latest`) |
