import { classifyComplexity } from './classifier.js'
import type { ClassifyResult } from './classifier.js'
import type { Complexity, PlaneIssue, RoutingRule, SukhoiConfig } from './types.js'

export interface RouteResult {
  model: string       // resolved "provider/model" string
  reason: string      // why this model was selected (routing rule explanation)
  complexity: ClassifyResult | null  // classifier output if used, null otherwise
}


function matchesRule(
  rule: RoutingRule,
  issue: PlaneIssue,
  complexity: Complexity | null
): boolean {
  const { priority, labels, complexity: complexityMatch } = rule.match

  const priorityOk =
    !priority || priority.length === 0 || priority.includes(issue.priority)

  const labelsOk =
    !labels ||
    labels.length === 0 ||
    issue.labels.some((l) => labels.includes(l.name))

  let complexityOk = true
  if (complexityMatch && complexityMatch.length > 0) {
    if (complexity === null) return false
    complexityOk = complexityMatch.includes(complexity)
  }

  const checks: boolean[] = []
  if (priority && priority.length > 0) checks.push(priorityOk)
  if (labels && labels.length > 0) checks.push(labelsOk)
  if (complexityMatch && complexityMatch.length > 0) checks.push(complexityOk)

  return checks.length > 0 && checks.every(Boolean)
}

function buildReason(
  rule: RoutingRule | null,
  modelAlias: string,
  model: string,
  complexity: Complexity | null
): string {
  if (!rule) {
    return `No routing rule matched — fell back to default model \`${modelAlias}\` (\`${model}\`).`
  }

  const parts: string[] = [`Rule **"${rule.name}"** matched`]

  const conditions: string[] = []
  if (rule.match.priority?.length) {
    conditions.push(`priority is \`${rule.match.priority.join(' or ')}\``)
  }
  if (rule.match.labels?.length) {
    conditions.push(`label matches \`${rule.match.labels.join(' or ')}\``)
  }
  if (rule.match.complexity?.length) {
    conditions.push(
      `task complexity classified as \`${complexity}\` (matches \`${rule.match.complexity.join(' or ')}\`)`
    )
  }

  if (conditions.length > 0) {
    parts.push(`because ${conditions.join(' and ')}`)
  }

  parts.push(`→ selected \`${modelAlias}\` (\`${model}\`)`)
  return parts.join(' ')
}

export async function routeModel(
  issue: PlaneIssue,
  config: SukhoiConfig
): Promise<RouteResult> {
  let classified: ClassifyResult | null = null

  // Evaluate rules sequentially — first match wins.
  // Classifier is called lazily (at most once) only when a rule requires complexity.
  for (const rule of config.routing) {
    const hasComplexity = rule.match.complexity && rule.match.complexity.length > 0

    if (hasComplexity && classified === null) {
      classified = await classifyComplexity(issue, config)
    }

    if (matchesRule(rule, issue, classified?.result ?? null)) {
      const model = config.models[rule.model]!
      const reason = buildReason(rule, rule.model, model, classified?.result ?? null)
      console.log(`[router] Rule "${rule.name}" matched → ${model}`)
      return { model, reason, complexity: classified }
    }
  }

  const defaultModel = config.models[config.defaultModel]!
  const reason = buildReason(null, config.defaultModel, defaultModel, classified?.result ?? null)
  console.log(`[router] No rule matched → default ${defaultModel}`)
  return { model: defaultModel, reason, complexity: classified }
}
