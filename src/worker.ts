import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { env, getConfig } from './config.js'
import { addComment, getIssue, getStateId, updateIssueState } from './plane.js'
import { buildPlaneComment, buildPrBody, buildPrompt } from './prompt.js'
import { routeModel } from './router.js'
import type { Job, RunnerResult } from './types.js'

const RUNNER_IMAGE = process.env['RUNNER_IMAGE'] ?? 'sukhoi-runner:latest'
const REPO_CACHE_VOLUME = 'sukhoi-repos'

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
  const model = await routeModel(issue, config)
  console.log(`[worker] Model: ${model}`)

  // ── Build prompt ───────────────────────────────────────────────────────────
  const prompt = buildPrompt(config, issue)
  const branchName = `fix/${issueLabel.toLowerCase()}`
  const prBody = buildPrBody(issue, model, branchName)

  // ── Authenticated repo URL (HTTPS token-based, no SSH key needed) ──────────
  const repoUrl = buildAuthenticatedRepoUrl(config.repo, env.githubToken)

  // ── Prepare result dir (mounted from host into container) ──────────────────
  const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sukhoi-'))
  const resultFile = path.join(resultDir, 'result.json')

  // ── Spawn Docker container ─────────────────────────────────────────────────
  const dockerArgs = [
    'run',
    '--rm',
    // Mount result dir so we can read result.json after container exits
    '--volume', `${resultDir}:/workspace`,
    // Persistent repo cache volume (shared across all runner containers)
    '--volume', `${REPO_CACHE_VOLUME}:/repo-cache`,
    // Pass all env vars
    '--env', `GITHUB_TOKEN=${env.githubToken}`,
    '--env', `REPO_URL=${repoUrl}`,
    '--env', `BASE_BRANCH=${config.baseBranch}`,
    '--env', `BRANCH_NAME=${branchName}`,
    '--env', `ISSUE_ID=${issueLabel}`,
    '--env', `ISSUE_TITLE=${issue.name}`,
    '--env', `MODEL=${model}`,
    '--env', `PROMPT=${prompt}`,
    '--env', `PR_BODY=${prBody}`,
    '--env', `ANTHROPIC_API_KEY=${env.anthropicApiKey}`,
    '--env', `OPENAI_API_KEY=${env.openaiApiKey}`,
    '--env', `OPENROUTER_API_KEY=${env.openrouterApiKey}`,
    '--env', `WORKLOG_ENABLED=${config.worklog?.enabled ?? false}`,
    '--env', `WORKLOG_MAX_ENTRIES=${config.worklog?.maxEntries ?? 20}`,
    RUNNER_IMAGE,
  ]

  console.log(`[worker] Running docker container with model ${model}...`)

  const result = spawnSync('docker', dockerArgs, {
    timeout: env.jobTimeoutMs,
    stdio: 'inherit',
    encoding: 'utf-8',
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
      `**Sukhoi agent failed for BOOTH9-${issue.sequence_id}.**\n\nError: \`${errMsg}\`\n\nTask has been returned to Todo. Please review and retry.`
    )
    // Clean up temp dir
    fs.rmSync(resultDir, { recursive: true, force: true })
    return
  }

  // Read result.json written by entrypoint.sh
  let runnerResult: RunnerResult = {
    pr_url: null,
    commit_url: null,
    commit_sha: null,
    branch: null,
    skipped: false,
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
    model,
    runnerResult.pr_url,
    runnerResult.commit_url
  )
  await addComment(projectId, issueId, comment)
  console.log(`[worker] Comment posted on ${issueLabel}`)

  if (runnerResult.pr_url) {
    console.log(`[worker] PR: ${runnerResult.pr_url}`)
  }
}
