#!/bin/bash
set -euo pipefail

# Required env vars (passed by sukhoi service):
#   GITHUB_TOKEN     - GitHub PAT for auth + gh CLI
#   REPO_URL         - Git clone URL of target repo
#   BASE_BRANCH      - Base branch to create new branch from (e.g. "main")
#   BRANCH_NAME      - New branch name (e.g. "fix/booth9-42")
#   ISSUE_ID         - Issue identifier (e.g. "BOOTH9-42")
#   ISSUE_TITLE      - Issue title (for PR title)
#   MODEL            - OpenCode model string (e.g. "anthropic/claude-sonnet-4-20250514")
#   PROMPT           - Full prompt (operation prompt + task context, pre-built by sukhoi)
#   REPO_CACHE_DIR   - Host path mounted at /repo-cache (persistent git clone)
#
# Optional env vars (passed through for OpenCode):
#   ANTHROPIC_API_KEY
#   OPENAI_API_KEY
#   OPENROUTER_API_KEY

CACHE_DIR="/repo-cache"       # persistent volume mount point
WORKTREE_DIR="/workspace/task" # isolated working tree for this task
RESULT_FILE="/workspace/result.json"

# ── 1. Auth GitHub ───────────────────────────────────────────────────────────
echo "[sukhoi-runner] Authenticating with GitHub..."
echo "$GITHUB_TOKEN" | gh auth login --with-token
gh auth setup-git

# ── 2. Configure git identity ────────────────────────────────────────────────
git config --global user.email "sukhoi-agent@noreply.local"
git config --global user.name "Sukhoi Agent"

# ── 3. Ensure persistent repo cache ─────────────────────────────────────────
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

  # Try fetch + reset. If anything fails, nuke and re-clone.
  if git fetch origin && git checkout "$BASE_BRANCH" && git reset --hard "origin/$BASE_BRANCH"; then
    echo "[sukhoi-runner] Cache updated to origin/$BASE_BRANCH."
    # Clean up any leftover worktrees from crashed previous runs
    git worktree prune
  else
    echo "[sukhoi-runner] Conflict or fetch error — destroying cache and re-cloning..."
    cd /
    rm -rf "$CACHE_DIR"
    git clone "$REPO_URL" "$CACHE_DIR"
  fi
}

ensure_repo_cache

# ── 4. Create isolated worktree for this task ────────────────────────────────
echo "[sukhoi-runner] Creating worktree for branch $BRANCH_NAME..."
cd "$CACHE_DIR"

# Remove stale worktree entry for this branch if it exists (e.g. from a crash)
git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true
git branch -D "$BRANCH_NAME" 2>/dev/null || true

git worktree add -b "$BRANCH_NAME" "$WORKTREE_DIR" "origin/$BASE_BRANCH"
echo "[sukhoi-runner] Worktree ready at $WORKTREE_DIR (branch: $BRANCH_NAME)."

cd "$WORKTREE_DIR"

# ── 5. Install dependencies ──────────────────────────────────────────────────
# pnpm reuses its local store — only downloads packages not already cached
echo "[sukhoi-runner] Installing dependencies..."
pnpm install --frozen-lockfile

# ── 6. Run OpenCode agent ────────────────────────────────────────────────────
echo "[sukhoi-runner] Running OpenCode with model: $MODEL"
opencode run \
  --model "$MODEL" \
  --print \
  "$PROMPT"

# ── 7. Verify typecheck ──────────────────────────────────────────────────────
echo "[sukhoi-runner] Running typecheck..."
pnpm typecheck

# ── 8. Commit changes ────────────────────────────────────────────────────────
git add -A

if git diff --cached --quiet; then
  echo "[sukhoi-runner] No changes to commit. Exiting."
  echo '{"pr_url": null, "commit_url": null, "skipped": true}' > "$RESULT_FILE"
  # Cleanup worktree
  cd "$CACHE_DIR"
  git worktree remove --force "$WORKTREE_DIR"
  git branch -D "$BRANCH_NAME"
  exit 0
fi

git commit -m "fix: resolve $ISSUE_ID

Automated implementation by Sukhoi agent.
Model: $MODEL"

# ── 9. Push branch ───────────────────────────────────────────────────────────
echo "[sukhoi-runner] Pushing branch..."
git push origin "$BRANCH_NAME"

# Build commit URL
REMOTE_URL=$(git remote get-url origin)
HTTPS_REMOTE=$(echo "$REMOTE_URL" \
  | sed 's|git@github.com:|https://github.com/|' \
  | sed 's|\.git$||')

COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_URL="${HTTPS_REMOTE}/commit/${COMMIT_SHA}"

# ── 10. Create PR ────────────────────────────────────────────────────────────
echo "[sukhoi-runner] Creating pull request..."
PR_BODY="Resolves task: **${ISSUE_ID}**

## Changes

This PR was automatically implemented by [Sukhoi](https://github.com/tigor/sukhoi) autonomous coding agent.

**Model:** \`${MODEL}\`
**Branch:** \`${BRANCH_NAME}\`
**Commit:** ${COMMIT_URL}"

PR_URL=$(gh pr create \
  --title "fix: ${ISSUE_TITLE}" \
  --body "$PR_BODY" \
  --base "$BASE_BRANCH" \
  --head "$BRANCH_NAME")

echo "[sukhoi-runner] PR created: $PR_URL"

# ── 11. Cleanup worktree (keep repo cache) ───────────────────────────────────
cd "$CACHE_DIR"
git worktree remove --force "$WORKTREE_DIR"
# Keep the branch in cache so git doesn't complain — it's already pushed
# It will be pruned on next fetch cycle if needed

# ── 12. Write result for sukhoi service ──────────────────────────────────────
cat > "$RESULT_FILE" <<EOF
{
  "pr_url": "$PR_URL",
  "commit_url": "$COMMIT_URL",
  "commit_sha": "$COMMIT_SHA",
  "branch": "$BRANCH_NAME",
  "skipped": false
}
EOF

echo "[sukhoi-runner] Done."
