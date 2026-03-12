#!/bin/bash
set -euo pipefail

# Required env vars (passed by sukhoi service):
#   GITHUB_TOKEN     - GitHub PAT for auth + gh CLI
#   REPO_URL         - Git clone URL of target repo
#   BASE_BRANCH      - Base branch to create new branch from (e.g. "main")
#   BRANCH_NAME      - New branch name (e.g. "fix/BOOTH9-42")
#   ISSUE_ID         - Issue identifier (e.g. "BOOTH9-42")
#   ISSUE_TITLE      - Issue title (for PR title)
#   MODEL            - OpenCode model string (e.g. "anthropic/claude-sonnet-4-20250514")
#   PROMPT           - Full prompt (operation prompt + task context, pre-built by sukhoi)
#
# Optional env vars (passed through for OpenCode):
#   ANTHROPIC_API_KEY
#   OPENAI_API_KEY
#   OPENROUTER_API_KEY

REPO_DIR="/workspace/repo"
RESULT_FILE="/workspace/result.json"

# ── 1. Auth GitHub ──────────────────────────────────────────────────────────
echo "[sukhoi-runner] Authenticating with GitHub..."
echo "$GITHUB_TOKEN" | gh auth login --with-token
gh auth setup-git

# ── 2. Configure git identity ───────────────────────────────────────────────
git config --global user.email "sukhoi-agent@noreply.local"
git config --global user.name "Sukhoi Agent"

# ── 3. Clone repo + checkout branch ─────────────────────────────────────────
echo "[sukhoi-runner] Cloning $REPO_URL..."
git clone "$REPO_URL" "$REPO_DIR"
cd "$REPO_DIR"

git checkout "$BASE_BRANCH"
git checkout -b "$BRANCH_NAME"
echo "[sukhoi-runner] Branch '$BRANCH_NAME' created from '$BASE_BRANCH'."

# ── 4. Install dependencies ──────────────────────────────────────────────────
echo "[sukhoi-runner] Installing dependencies..."
pnpm install --frozen-lockfile

# ── 5. Run OpenCode agent ────────────────────────────────────────────────────
echo "[sukhoi-runner] Running OpenCode with model: $MODEL"
opencode run \
  --model "$MODEL" \
  --print \
  "$PROMPT"

# ── 6. Verify typecheck ──────────────────────────────────────────────────────
echo "[sukhoi-runner] Running typecheck..."
pnpm typecheck

# ── 7. Commit changes ────────────────────────────────────────────────────────
git add -A

if git diff --cached --quiet; then
  echo "[sukhoi-runner] No changes to commit. Exiting."
  echo '{"pr_url": null, "commit_url": null, "skipped": true}' > "$RESULT_FILE"
  exit 0
fi

git commit -m "fix: resolve $ISSUE_ID

Automated implementation by Sukhoi agent.
Model: $MODEL"

# ── 8. Push branch ───────────────────────────────────────────────────────────
echo "[sukhoi-runner] Pushing branch..."
git push origin "$BRANCH_NAME"

# Build commit URL from remote
REMOTE_URL=$(git remote get-url origin)
# Convert git URL to https URL if needed (git@github.com:user/repo.git → https://github.com/user/repo)
HTTPS_REMOTE=$(echo "$REMOTE_URL" \
  | sed 's|git@github.com:|https://github.com/|' \
  | sed 's|\.git$||')

COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_URL="${HTTPS_REMOTE}/commit/${COMMIT_SHA}"

# ── 9. Create PR ─────────────────────────────────────────────────────────────
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

# ── 10. Write result for sukhoi service ──────────────────────────────────────
cat > "$RESULT_FILE" <<EOF
{
  "pr_url": "$PR_URL",
  "commit_url": "$COMMIT_URL",
  "commit_sha": "$COMMIT_SHA",
  "branch": "$BRANCH_NAME",
  "skipped": false
}
EOF

echo "[sukhoi-runner] Done. Result written to $RESULT_FILE"
