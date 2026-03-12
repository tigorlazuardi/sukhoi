FROM node:22-slim AS builder

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Runtime image ─────────────────────────────────────────────────────────────
FROM node:22-slim

# System deps: git + curl + ca-certificates for gh CLI install
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# pnpm (for target repo dependency installs)
RUN corepack enable && corepack prepare pnpm@latest --activate

# Wrangler (Cloudflare Workers)
RUN npm install -g wrangler

# OpenCode CLI — pin to specific version when OPENCODE_VERSION build arg is provided
ARG OPENCODE_VERSION=latest
RUN npm install -g opencode-ai@${OPENCODE_VERSION}

# ── Sukhoi service ────────────────────────────────────────────────────────────
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

# Runner entrypoint script (called directly as a subprocess, not via docker run)
COPY runner/entrypoint.sh /runner/entrypoint.sh
RUN chmod +x /runner/entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
