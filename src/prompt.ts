import { stripHtml } from './classifier.js'
import type { PlaneIssue, SukhoiConfig } from './types.js'

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

  return `${config.prompt}\n\n${taskContext}`
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

export function buildPlaneComment(
  issue: PlaneIssue,
  model: string,
  prUrl: string | null,
  commitUrl: string | null
): string {
  const lines = [
    `**Sukhoi agent completed task BOOTH9-${issue.sequence_id}.**`,
    '',
    `**Model used:** \`${model}\``,
  ]

  if (commitUrl) {
    lines.push(`**Commit:** [${commitUrl.split('/').pop()}](${commitUrl})`)
  }

  if (prUrl) {
    lines.push(`**Pull Request:** [${prUrl}](${prUrl})`)
  }

  if (!prUrl && !commitUrl) {
    lines.push('No changes were made.')
  }

  return lines.join('\n')
}
