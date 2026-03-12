import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { env, getConfig } from './config.js'
import { addComment, getIssue, getStateId, updateIssueState } from './plane.js'
import { buildPlaneComment, buildPrBody, buildPrompt } from './prompt.js'
import { routeModel } from './router.js'
import type { Job, RunnerResult } from './types.js'

const ENTRYPOINT = process.env['ENTRYPOINT'] ?? '/runner/entrypoint.sh'
const REPO_CACHE_DIR = process.env['REPO_CACHE_DIR'] ?? '/repo-cache'

/**
 * Convert a repo URL (SSH or HTTPS) to an authenticated HTTPS URL.
 * e.g. git@github.com:org/repo.git  → https://x-access-token:TOKEN@github.com/org/repo.git
 *      https://github.com/org/repo  → https://x-access-token:TOKEN@github.com/org/repo
 */
function buildAuthenticatedRepoUrl(repoUrl: string, token: string): string {
  // SSH format: git@github.com:org/repo.git
  const sshMatch = repoUrl.match(/^git@([^:]+):(.+)$/)
  if (sshMatch) {
    const [, host, path] = sshMatch
    return `https://x-access-token:${token}@${host}/${path}`
  }

  // HTTPS format: https://github.com/org/repo
  const httpsMatch = repoUrl.match(/^https?:\/\/([^/]+)\/(.+)$/)
  if (httpsMatch) {
    const [, host, repoPath] = httpsMatch
    return `https://x-access-token:${token}@${host}/${repoPath}`
  }

  // Fallback: return as-is
  return repoUrl
}

export async function processJob(job: Job): Promise<void> {
  const config = getConfig()
  const { issueId, projectId } = job

  console.log(`[worker] Processing job ${job.id} — issue ${issueId}`)

  // ── Fetch issue ────────────────────────────────────────────────────────────
  const issue = await getIssue(projectId, issueId)
  const issueLabel = `BOOTH9-${issue.sequence_id}`
  console.log(`[worker] Issue: ${issueLabel} — ${issue.name}`)

  // ── Update state → In Progress ─────────────────────────────────────────────
  const inProgressId = await getStateId(projectId, 'In Progress')
  await updateIssueState(projectId, issueId, inProgressId)
  console.log(`[worker] State → In Progress`)

  // ── Route model ────────────────────────────────────────────────────────────
  const { model, reason: modelReason } = await routeModel(issue, config)
  console.log(`[worker] Model: ${model} — ${modelReason}`)

  // ── Build prompt ───────────────────────────────────────────────────────────
  const prompt = buildPrompt(config, issue)
  const branchName = `fix/${issueLabel.toLowerCase()}`
  const prBody = buildPrBody(issue, model, branchName)

  // ── Authenticated repo URL (HTTPS token-based, no SSH key needed) ──────────
  const repoUrl = buildAuthenticatedRepoUrl(config.repo, env.githubToken)

  // ── Prepare result dir (temp dir on local filesystem) ─────────────────────
  const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sukhoi-'))
  const resultFile = path.join(resultDir, 'result.json')

  // ── Build env for entrypoint.sh ───────────────────────────────────────────
  const runnerEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    GITHUB_TOKEN:        env.githubToken,
    REPO_URL:            repoUrl,
    BASE_BRANCH:         config.baseBranch,
    BRANCH_NAME:         branchName,
    ISSUE_ID:            issueLabel,
    ISSUE_TITLE:         issue.name,
    MODEL:               model,
    PROMPT:              prompt,
    PR_BODY:             prBody,
    ANTHROPIC_API_KEY:   env.anthropicApiKey,
    OPENAI_API_KEY:      env.openaiApiKey,
    OPENROUTER_API_KEY:  env.openrouterApiKey,
    WORKLOG_ENABLED:     String(config.worklog?.enabled ?? false),
    WORKLOG_MAX_ENTRIES: String(config.worklog?.maxEntries ?? 20),
    MODEL_REASON:        modelReason,
    RESULT_DIR:          resultDir,
    REPO_CACHE_DIR:      REPO_CACHE_DIR,
  }

  // If user provided an opencode config, expose its path to the entrypoint
  if (env.opencodeConfigHostPath) {
    runnerEnv['OPENCODE_CONFIG_PATH'] = env.opencodeConfigHostPath
  }

  console.log(`[worker] Running entrypoint for ${issueLabel} with model ${model}...`)

  // ── Run entrypoint.sh directly as a subprocess ────────────────────────────
  const result = spawnSync('bash', [ENTRYPOINT], {
    timeout: env.jobTimeoutMs,
    stdio:   'inherit',
    encoding: 'utf-8',
    env: runnerEnv,
  })

  // ── Handle result ──────────────────────────────────────────────────────────
  if (result.status !== 0 || result.error) {
    const errMsg = result.error?.message ?? `exit code ${result.status}`
    console.error(`[worker] Runner failed: ${errMsg}`)

    const todoId = await getStateId(projectId, 'Todo')
    await updateIssueState(projectId, issueId, todoId)
    await addComment(
      projectId,
      issueId,
      `**Sukhoi agent failed for ${issueLabel}.**\n\nError: \`${errMsg}\`\n\nTask has been returned to Todo. Please review and retry.`
    )
    fs.rmSync(resultDir, { recursive: true, force: true })
    return
  }

  // Read result.json written by entrypoint.sh
  let runnerResult: RunnerResult = {
    pr_url:       null,
    commit_url:   null,
    commit_sha:   null,
    branch:       null,
    model:        model,
    model_reason: modelReason,
    skipped:      false,
    usage:        null,
  }

  try {
    const raw = fs.readFileSync(resultFile, 'utf-8')
    runnerResult = JSON.parse(raw) as RunnerResult
  } catch {
    console.warn('[worker] Could not read result.json, continuing anyway')
  }

  fs.rmSync(resultDir, { recursive: true, force: true })

  // ── Update Plane state → Review/Testing ───────────────────────────────────
  const reviewId = await getStateId(projectId, 'Review/Testing')
  await updateIssueState(projectId, issueId, reviewId)
  console.log(`[worker] State → Review/Testing`)

  // ── Post comment on Plane issue ────────────────────────────────────────────
  const comment = buildPlaneComment(
    issue,
    runnerResult.model ?? model,
    runnerResult.model_reason ?? modelReason,
    runnerResult.pr_url,
    runnerResult.commit_url,
    runnerResult.usage,
  )
  await addComment(projectId, issueId, comment)
  console.log(`[worker] Comment posted on ${issueLabel}`)

  if (runnerResult.pr_url) {
    console.log(`[worker] PR: ${runnerResult.pr_url}`)
  }
}
