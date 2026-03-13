import { stripHtml } from './classifier.js'
import type { ClassifyResult } from './classifier.js'
import type { PlaneIssue, RunnerUsage, SukhoiConfig } from './types.js'

export function buildPrompt(config: SukhoiConfig, issue: PlaneIssue): string {
  const labels =
    issue.labels.length > 0
      ? issue.labels.map((l) => l.name).join(', ')
      : 'none'

  const parentLine = issue.parent
    ? `Part of: ${issue.parent.name}`
    : ''

  const description = stripHtml(issue.description_html)

  const taskContext = [
    '---',
    `Task: BOOTH9-${issue.sequence_id}`,
    `Title: ${issue.name}`,
    `Priority: ${issue.priority}`,
    `Labels: ${labels}`,
    parentLine,
    '',
    'Description:',
    description || '(no description)',
    '---',
  ]
    .filter((line) => line !== undefined)
    .join('\n')

  const worklogNote =
    config.worklog?.enabled
      ? '\n\nIf the file .sukhoi/worklog.md exists in the project root, read it ' +
        'before starting work. It contains a log of recent tasks completed by ' +
        'this agent — use it to understand prior decisions and avoid repeating mistakes.'
      : ''

  return `${config.prompt}${worklogNote}\n\n${taskContext}`
}

export function buildPrBody(
  issue: PlaneIssue,
  model: string,
  branchName: string
): string {
  return [
    `Resolves task: **BOOTH9-${issue.sequence_id}** — ${issue.name}`,
    '',
    '## Summary',
    '',
    'This PR was automatically implemented by [Sukhoi](https://github.com/tigor/sukhoi) autonomous coding agent.',
    '',
    `**Model:** \`${model}\``,
    `**Branch:** \`${branchName}\``,
    `**Priority:** ${issue.priority}`,
    issue.labels.length > 0
      ? `**Labels:** ${issue.labels.map((l) => l.name).join(', ')}`
      : '',
  ]
    .filter((l) => l !== undefined)
    .join('\n')
}

export function buildRoutingComment(
  issue: PlaneIssue,
  model: string,
  modelReason: string,
  complexity: ClassifyResult | null,
): string {
  const lines = [
    `**Sukhoi is working on BOOTH9-${issue.sequence_id}.**`,
    '',
    `**Model:** \`${model}\``,
    `**Why:** ${modelReason}`,
  ]

  if (complexity) {
    lines.push(`**Complexity:** \`${complexity.result}\``)
    lines.push(`**Complexity reason:** ${complexity.reason}`)
  }

  return lines.join('\n')
}

export function buildQueuedComment(issue: PlaneIssue, queueDepth: number): string {
  const lines = [
    `**Sukhoi received BOOTH9-${issue.sequence_id}.**`,
    '',
    queueDepth <= 1
      ? 'Task is next in line and will start shortly.'
      : `Task queued at position ${queueDepth}. It will start after ${queueDepth - 1} job(s) ahead of it.`,
  ]
  return lines.join('\n')
}

export function buildPlaneComment(
  issue: PlaneIssue,
  prUrl: string | null,
  commitUrl: string | null,
  usage: RunnerUsage | null,
  diffStat: string | null,
): string {
  const lines = [
    `**Sukhoi agent completed BOOTH9-${issue.sequence_id}.**`,
    '',
  ]

  if (prUrl) {
    lines.push(`**Pull Request:** [${prUrl}](${prUrl})`)
  }
  if (commitUrl) {
    lines.push(`**Commit:** [${commitUrl.split('/').pop()}](${commitUrl})`)
  }
  if (!prUrl && !commitUrl) {
    lines.push('No changes were made.')
  }

  if (diffStat) {
    lines.push('')
    lines.push('**Changes:**')
    lines.push('```')
    lines.push(diffStat)
    lines.push('```')
  }

  if (usage) {
    const costStr = usage.cost_usd > 0
      ? `$${usage.cost_usd.toFixed(6)}`
      : '<$0.000001'

    lines.push('')
    lines.push('**Usage:**')
    lines.push(
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Cost | ${costStr} |`,
      `| Input tokens | ${usage.tokens_input.toLocaleString()} |`,
      `| Output tokens | ${usage.tokens_output.toLocaleString()} |`,
      `| Cache read | ${usage.tokens_cache_read.toLocaleString()} |`,
      `| Cache write | ${usage.tokens_cache_write.toLocaleString()} |`,
    )
  }

  return lines.join('\n')
}
