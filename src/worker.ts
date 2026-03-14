import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { env, getConfig } from './config.js'
import { addComment, getIssue, getStateId, updateIssueState } from './plane.js'
import { buildPlaneComment, buildPrBody, buildPrompt, buildRoutingComment } from './prompt.js'
import { routeModel } from './router.js'
import type { Job, RunnerResult } from './types.js'

const ENTRYPOINT = process.env['ENTRYPOINT'] ?? '/runner/entrypoint.sh'
const REPO_CACHE_DIR = process.env['REPO_CACHE_DIR'] ?? '/repo-cache'

interface SpawnResult {
  status: number | null
  error?: Error
}

function runEntrypoint(
  entrypoint: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', [entrypoint], {
      stdio: 'inherit',
      env,
    })

    let settled = false
    const finish = (result: SpawnResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }

    const onAbort = (): void => {
      console.log('[worker] Abort signal received — killing child process')
      child.kill('SIGTERM')
      // Force kill after 5s if still running
      setTimeout(() => child.kill('SIGKILL'), 5000)
    }

    const timer = setTimeout(() => {
      console.log(`[worker] Job timed out after ${timeoutMs}ms — killing child process`)
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000)
      finish({ status: null, error: new Error(`timed out after ${timeoutMs}ms`) })
    }, timeoutMs)

    signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => finish({ status: null, error: err }))
    child.on('close', (code) => finish({ status: code }))
  })
}

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
  const inProgressId = await getStateId(projectId, config.states.inProgress)
  await updateIssueState(projectId, issueId, inProgressId)
  console.log(`[worker] State → ${config.states.inProgress}`)

  // ── Route model ────────────────────────────────────────────────────────────
  const { model, reason: modelReason, complexity: classified } = await routeModel(issue, config)
  console.log(`[worker] Model: ${model} — ${modelReason}`)

  // ── Post routing comment immediately ──────────────────────────────────────
  await addComment(
    projectId,
    issueId,
    buildRoutingComment(issue, model, modelReason, classified),
  )
  console.log(`[worker] Routing comment posted on ${issueLabel}`)

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
    COMPLEXITY:          classified?.result ?? '',
    COMPLEXITY_REASON:   classified?.reason ?? '',
    RESULT_DIR:          resultDir,
    REPO_CACHE_DIR:      REPO_CACHE_DIR,
  }

  // If user provided an opencode config, expose its path to the entrypoint
  if (env.opencodeConfigPath) {
    runnerEnv['OPENCODE_CONFIG_PATH'] = env.opencodeConfigPath
  }

  console.log(`[worker] Running entrypoint for ${issueLabel} with model ${model}...`)

  // ── Run entrypoint.sh ─────────────────────────────────────────────────────
  const logFile = path.join(resultDir, 'runner.log')
  const summaryFile = path.join(resultDir, 'summary.md')
  const result = await runEntrypoint(
    ENTRYPOINT,
    { ...runnerEnv, LOG_FILE: logFile, SUMMARY_FILE: summaryFile },
    env.jobTimeoutMs,
    job.signal,
  )

  // ── Handle result ──────────────────────────────────────────────────────────
  if (result.status !== 0 || result.error) {
    const errMsg = result.error?.message ?? `exit code ${result.status}`
    console.error(`[worker] Runner failed: ${errMsg}`)

    // Read last 50 lines of log for error context
    let logTail = ''
    try {
      const logContent = fs.readFileSync(logFile, 'utf-8')
      const lines = logContent.trimEnd().split('\n')
      logTail = lines.slice(-50).join('\n')
    } catch {
      // log file may not exist if entrypoint never started
    }

  const cancelledId = await getStateId(projectId, config.states.failed)
  await updateIssueState(projectId, issueId, cancelledId)
    await addComment(
      projectId,
      issueId,
      [
        `**Sukhoi agent failed for ${issueLabel}.**`,
        '',
        `Error: \`${errMsg}\``,
        '',
        logTail ? `**Last output:**\n\`\`\`\n${logTail}\n\`\`\`` : '',
        '',
        'Task has been moved to Cancelled. Move back to Todo to retry.',
      ].join('\n').trimEnd()
    )
    fs.rmSync(resultDir, { recursive: true, force: true })
    return
  }

  // Read result.json written by entrypoint.sh
  let runnerResult: RunnerResult = {
    pr_url:            null,
    commit_url:        null,
    commit_sha:        null,
    branch:            null,
    model:             model,
    model_reason:      modelReason,
    complexity:        classified?.result ?? null,
    complexity_reason: classified?.reason ?? null,
    diff_stat:         null,
    summary:           null,
    skipped:           false,
    usage:             null,
  }

  try {
    const raw = fs.readFileSync(resultFile, 'utf-8')
    runnerResult = JSON.parse(raw) as RunnerResult
  } catch {
    console.warn('[worker] Could not read result.json, continuing anyway')
  }

  // Read summary.md written by LLM (may not exist)
  try {
    runnerResult.summary = fs.readFileSync(summaryFile, 'utf-8').trim()
  } catch {
    // summary is optional
  }

  fs.rmSync(resultDir, { recursive: true, force: true })

  // ── Update Plane state → Review/Testing ───────────────────────────────────
  const reviewId = await getStateId(projectId, config.states.done)
  await updateIssueState(projectId, issueId, reviewId)
  console.log(`[worker] State → ${config.states.done}`)

  // ── Post comment on Plane issue ────────────────────────────────────────────
  const comment = buildPlaneComment(
    issue,
    runnerResult.pr_url,
    runnerResult.commit_url,
    runnerResult.usage,
    runnerResult.summary ?? null,
    runnerResult.skipped,
  )
  await addComment(projectId, issueId, comment)
  console.log(`[worker] Comment posted on ${issueLabel}`)

  if (runnerResult.pr_url) {
    console.log(`[worker] PR: ${runnerResult.pr_url}`)
  }
}
