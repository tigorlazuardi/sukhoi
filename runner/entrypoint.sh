#!/bin/bash
set -euo pipefail

# Required env vars (passed by worker.ts):
#   GITHUB_TOKEN        - GitHub PAT for auth + gh CLI
#   REPO_URL            - Authenticated HTTPS clone URL of target repo
#   BASE_BRANCH         - Base branch (e.g. "main")
#   BRANCH_NAME         - New branch name (e.g. "fix/booth9-42")
#   ISSUE_ID            - Issue identifier (e.g. "BOOTH9-42")
#   ISSUE_TITLE         - Issue title (for PR title)
#   MODEL               - OpenCode model string (e.g. "anthropic/claude-sonnet-4-20250514")
#   PROMPT              - Full prompt (pre-built by sukhoi)
#   RESULT_DIR          - Directory to write result.json into
#   REPO_CACHE_DIR      - Persistent repo cache directory (volume mount)
#   WORKLOG_ENABLED     - "true" to enable persistent work log (default: "false")
#   WORKLOG_MAX_ENTRIES - Max entries to keep in worklog (default: 20)
#   MODEL_REASON        - Human-readable reason why this model was selected
#
# Optional env vars:
#   OPENCODE_CONFIG_PATH - Host path to opencode config file (MCP servers, etc.)
#   ANTHROPIC_API_KEY
#   OPENAI_API_KEY
#   OPENROUTER_API_KEY

CACHE_DIR="${REPO_CACHE_DIR:-/repo-cache}"
WORKTREE_DIR="${CACHE_DIR}/worktrees/${BRANCH_NAME}"
RESULT_FILE="${RESULT_DIR}/result.json"
WORKLOG_CACHE="${CACHE_DIR}/.sukhoi/worklog.md"
WORKLOG_WORKTREE="${WORKTREE_DIR}/.sukhoi/worklog.md"
WORKLOG_ENABLED="${WORKLOG_ENABLED:-false}"
WORKLOG_MAX_ENTRIES="${WORKLOG_MAX_ENTRIES:-20}"

# ── 1. Auth GitHub ───────────────────────────────────────────────────────────
echo "[sukhoi-runner] Authenticating with GitHub..."
echo "$GITHUB_TOKEN" | gh auth login --with-token
gh auth setup-git

# ── 2. Configure git identity ────────────────────────────────────────────────
git config --global user.email "sukhoi-agent@noreply.local"
git config --global user.name "Sukhoi Agent"

# ── 3. Load opencode config if provided ──────────────────────────────────────
if [ -n "${OPENCODE_CONFIG_PATH:-}" ] && [ -f "$OPENCODE_CONFIG_PATH" ]; then
  echo "[sukhoi-runner] Loading opencode config from $OPENCODE_CONFIG_PATH..."
  mkdir -p "$HOME/.config/opencode"
  cp "$OPENCODE_CONFIG_PATH" "$HOME/.config/opencode/config.json"
fi

# ── 4. Ensure persistent repo cache ─────────────────────────────────────────
# Strategy:
#   a) If cache missing           → fresh clone
#   b) If cache exists            → git fetch + reset --hard to base branch
#   c) If fetch/reset fails       → destroy cache + fresh clone (conflict recovery)

ensure_repo_cache() {
  if [ ! -d "$CACHE_DIR/.git" ]; then
    echo "[sukhoi-runner] Cache empty — cloning $REPO_URL..."
    git clone "$REPO_URL" "$CACHE_DIR"
    return
  fi

  echo "[sukhoi-runner] Cache found — fetching latest..."
  cd "$CACHE_DIR"

  if git fetch origin && git checkout "$BASE_BRANCH" && git reset --hard "origin/$BASE_BRANCH"; then
    echo "[sukhoi-runner] Cache updated to origin/$BASE_BRANCH."
    git worktree prune
  else
    echo "[sukhoi-runner] Conflict or fetch error — destroying cache and re-cloning..."
    cd /
    rm -rf "$CACHE_DIR"
    git clone "$REPO_URL" "$CACHE_DIR"
  fi
}

ensure_repo_cache

# ── 5. Create isolated worktree for this task ────────────────────────────────
echo "[sukhoi-runner] Creating worktree for branch $BRANCH_NAME..."
cd "$CACHE_DIR"

git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true
git branch -D "$BRANCH_NAME" 2>/dev/null || true

mkdir -p "$(dirname "$WORKTREE_DIR")"
git worktree add -b "$BRANCH_NAME" "$WORKTREE_DIR" "origin/$BASE_BRANCH"
echo "[sukhoi-runner] Worktree ready at $WORKTREE_DIR (branch: $BRANCH_NAME)."

cd "$WORKTREE_DIR"

# ── 6. Install dependencies ──────────────────────────────────────────────────
echo "[sukhoi-runner] Installing dependencies..."
pnpm install --frozen-lockfile

# ── 7. Inject worklog into worktree (read-only context for OpenCode) ─────────
if [ "$WORKLOG_ENABLED" = "true" ] && [ -f "$WORKLOG_CACHE" ]; then
  echo "[sukhoi-runner] Injecting worklog into worktree..."
  mkdir -p "$WORKTREE_DIR/.sukhoi"
  cp "$WORKLOG_CACHE" "$WORKLOG_WORKTREE"
  # Exclude from git so it is never staged or committed
  echo ".sukhoi/worklog.md" >> "$WORKTREE_DIR/.git/info/exclude"
fi

# ── 8. Run OpenCode agent ────────────────────────────────────────────────────
echo "[sukhoi-runner] Running OpenCode with model: $MODEL"
OPENCODE_OUTPUT=$(mktemp)

opencode run \
  --model "$MODEL" \
  --format json \
  "$PROMPT" | tee "$OPENCODE_OUTPUT"

# ── Parse usage from JSON event stream ───────────────────────────────────────
# Aggregate all step_finish events: sum cost + tokens
USAGE_JSON=$(node -e "
const fs = require('fs');
const lines = fs.readFileSync('$OPENCODE_OUTPUT', 'utf8').trim().split('\n');
let totalCost = 0, inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheWrite = 0;
for (const line of lines) {
  try {
    const ev = JSON.parse(line);
    if (ev.type === 'step_finish' && ev.part) {
      totalCost += ev.part.cost ?? 0;
      inputTokens += ev.part.tokens?.input ?? 0;
      outputTokens += ev.part.tokens?.output ?? 0;
      cacheRead += ev.part.tokens?.cache?.read ?? 0;
      cacheWrite += ev.part.tokens?.cache?.write ?? 0;
    }
  } catch {}
}
console.log(JSON.stringify({
  cost_usd: Math.round(totalCost * 1e6) / 1e6,
  tokens_input: inputTokens,
  tokens_output: outputTokens,
  tokens_cache_read: cacheRead,
  tokens_cache_write: cacheWrite,
}));
")
rm -f "$OPENCODE_OUTPUT"
echo "[sukhoi-runner] Usage: $USAGE_JSON"

# ── 9. Verify typecheck ──────────────────────────────────────────────────────
echo "[sukhoi-runner] Running typecheck..."
pnpm typecheck

# ── 10. Commit changes ───────────────────────────────────────────────────────
git add -A

if git diff --cached --quiet; then
  echo "[sukhoi-runner] No changes to commit. Exiting."
  node -e "
const result = {
  pr_url: null, commit_url: null, commit_sha: null, branch: '${BRANCH_NAME}',
  model: '${MODEL}', model_reason: process.env.MODEL_REASON || '',
  skipped: true,
  usage: ${USAGE_JSON},
};
require('fs').writeFileSync('${RESULT_FILE}', JSON.stringify(result, null, 2));
" MODEL_REASON="$MODEL_REASON"
  cd "$CACHE_DIR"
  git worktree remove --force "$WORKTREE_DIR"
  git branch -D "$BRANCH_NAME"
  exit 0
fi

git commit -m "fix: resolve $ISSUE_ID

Automated implementation by Sukhoi agent.
Model: $MODEL"

# ── 11. Push branch ──────────────────────────────────────────────────────────
echo "[sukhoi-runner] Pushing branch..."
git push origin "$BRANCH_NAME"

# Build commit URL (strip auth token from remote URL)
REMOTE_URL=$(git remote get-url origin)
HTTPS_REMOTE=$(echo "$REMOTE_URL" \
  | sed 's|git@github.com:|https://github.com/|' \
  | sed 's|\.git$||' \
  | sed 's|https://x-access-token:[^@]*@|https://|')

COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_URL="${HTTPS_REMOTE}/commit/${COMMIT_SHA}"

# ── 12. Create PR ────────────────────────────────────────────────────────────
echo "[sukhoi-runner] Creating pull request..."
PR_BODY="Resolves task: **${ISSUE_ID}**

## Changes

This PR was automatically implemented by [Sukhoi](https://github.com/tigorlazuardi/sukhoi) autonomous coding agent.

**Model:** \`${MODEL}\`
**Branch:** \`${BRANCH_NAME}\`
**Commit:** ${COMMIT_URL}"

PR_URL=$(gh pr create \
  --title "fix: ${ISSUE_TITLE}" \
  --body "$PR_BODY" \
  --base "$BASE_BRANCH" \
  --head "$BRANCH_NAME")

echo "[sukhoi-runner] PR created: $PR_URL"

# ── 13. Update persistent worklog ────────────────────────────────────────────
if [ "$WORKLOG_ENABLED" = "true" ]; then
  echo "[sukhoi-runner] Updating worklog..."
  mkdir -p "$CACHE_DIR/.sukhoi"

  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  NEW_ENTRY="## ${ISSUE_ID} — ${TIMESTAMP}
**Task:** ${ISSUE_TITLE}
**Branch:** \`${BRANCH_NAME}\`
**PR:** ${PR_URL}
**Commit:** ${COMMIT_URL}
**Model:** \`${MODEL}\`
---"

  TMPLOG=$(mktemp)
  printf '%s\n' "$NEW_ENTRY" > "$TMPLOG"
  [ -f "$WORKLOG_CACHE" ] && cat "$WORKLOG_CACHE" >> "$TMPLOG"

  awk -v max="$WORKLOG_MAX_ENTRIES" '
    /^---$/ { count++; if (count > max) exit }
    { print }
  ' "$TMPLOG" > "$WORKLOG_CACHE"

  rm -f "$TMPLOG"
  echo "[sukhoi-runner] Worklog updated (max ${WORKLOG_MAX_ENTRIES} entries)."
fi

# ── 14. Cleanup worktree (keep repo cache) ───────────────────────────────────
cd "$CACHE_DIR"
git worktree remove --force "$WORKTREE_DIR"

# ── 15. Write result for sukhoi service ──────────────────────────────────────
# Merge usage JSON into result — node handles the merge cleanly
node -e "
const usage = ${USAGE_JSON};
const result = {
  pr_url: '${PR_URL}',
  commit_url: '${COMMIT_URL}',
  commit_sha: '${COMMIT_SHA}',
  branch: '${BRANCH_NAME}',
  model: '${MODEL}',
  model_reason: process.env.MODEL_REASON || '',
  skipped: false,
  usage,
};
require('fs').writeFileSync('${RESULT_FILE}', JSON.stringify(result, null, 2));
" MODEL_REASON="$MODEL_REASON"

echo "[sukhoi-runner] Done."
