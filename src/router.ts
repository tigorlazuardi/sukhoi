import { classifyComplexity } from './classifier.js'
import type { Complexity, PlaneIssue, RoutingRule, SukhoiConfig } from './types.js'

export interface RouteResult {
  model: string  // resolved "provider/model" string
  reason: string // human-readable explanation for the Plane comment
}

function ruleNeedsComplexity(rules: RoutingRule[]): boolean {
  return rules.some((r) => r.match.complexity && r.match.complexity.length > 0)
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
    if (complexity === null) return false // not yet classified
    complexityOk = complexityMatch.includes(complexity)
  }

  // All specified conditions must match (AND)
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
  let complexity: Complexity | null = null

  // First pass: try to match rules that don't need complexity (no LLM call)
  for (const rule of config.routing) {
    const needsComplexity =
      rule.match.complexity && rule.match.complexity.length > 0
    if (needsComplexity) continue

    if (matchesRule(rule, issue, null)) {
      const model = config.models[rule.model]!
      const reason = buildReason(rule, rule.model, model, null)
      console.log(`[router] Rule "${rule.name}" matched (no classifier) → ${model}`)
      return { model, reason }
    }
  }

  // Second pass: if any rules need complexity, classify once then evaluate all
  if (ruleNeedsComplexity(config.routing)) {
    complexity = await classifyComplexity(issue, config)

    for (const rule of config.routing) {
      if (matchesRule(rule, issue, complexity)) {
        const model = config.models[rule.model]!
        const reason = buildReason(rule, rule.model, model, complexity)
        console.log(
          `[router] Rule "${rule.name}" matched (complexity=${complexity}) → ${model}`
        )
        return { model, reason }
      }
    }
  }

  const defaultModel = config.models[config.defaultModel]!
  const reason = buildReason(null, config.defaultModel, defaultModel, complexity)
  console.log(`[router] No rule matched → default ${defaultModel}`)
  return { model: defaultModel, reason }
}
