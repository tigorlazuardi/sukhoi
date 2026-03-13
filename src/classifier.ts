import { spawnSync } from 'node:child_process'
import type { Complexity, PlaneIssue, SukhoiConfig } from './types.js'

export interface ClassifyResult {
    result: Complexity
    reason: string
}

function stripHtml(html: string | null): string {
    if (!html) return ''
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim()
}

function buildClassifierPrompt(
    complexity: Record<string, string>,
    issue: PlaneIssue
): string {
    const labels = Object.keys(complexity)
    const definitions = Object.entries(complexity)
        .map(([label, description]) => `- ${label}: ${description}`)
        .join('\n')

    const description = stripHtml(issue.description_html)
    const taskContent = `Task title: ${issue.name}\nTask description: ${description.slice(0, 1000)}`

    return `Classify this software engineering task into exactly one of the following categories.

${definitions}

YOU MUST respond with a JSON object with exactly two fields, no explanations or extra text outside the JSON object:
- "result": one of ${labels.map((l) => `"${l}"`).join(', ')}
- "reason": one sentence explaining why you chose that category

Example: {"result": "${labels[0]}", "reason": "This task involves..."}

${taskContent}`
}

function fallback(complexity: Record<string, string>): ClassifyResult {
    // Pick the middle key as default, or first if only one
    const keys = Object.keys(complexity)
    const mid = keys[Math.floor(keys.length / 2)] ?? keys[0] ?? 'typical'
    return { result: mid, reason: 'Classification unavailable, using default.' }
}

export async function classifyComplexity(
    issue: PlaneIssue,
    config: SukhoiConfig
): Promise<ClassifyResult> {
    if (!config.classifier.enabled) {
        return fallback(config.classifier.complexity)
    }

    const modelString = config.models[config.classifier.model]
    if (!modelString) {
        console.warn('[classifier] classifier.model not found in models, using fallback')
        return fallback(config.classifier.complexity)
    }

    const prompt = buildClassifierPrompt(config.classifier.complexity, issue)
    const validLabels = Object.keys(config.classifier.complexity)

    try {
        const result = spawnSync('opencode', ['run', '--model', modelString, prompt], {
            encoding: 'utf-8',
            timeout: 60_000,
            env: process.env,
        })

        if (result.error) {
            throw result.error
        }
        if (result.status !== 0) {
            throw new Error(`opencode exited with code ${result.status}: ${result.stderr}`)
        }

        const output = result.stdout.trim()

        // Extract JSON from output — opencode may include extra text/formatting
        const jsonMatch = output.match(/\{[\s\S]*\}/)
        if (!jsonMatch) {
            throw new Error(`No JSON found in opencode output: ${output.slice(0, 200)}`)
        }

        const parsed = JSON.parse(jsonMatch[0]) as { result?: string; reason?: string }
        const label = parsed.result?.trim().toLowerCase() ?? ''
        const reason = parsed.reason?.trim() ?? ''

        if (validLabels.includes(label)) {
            console.log(`[classifier] "${issue.name}" → ${label}: ${reason}`)
            return { result: label, reason }
        }

        console.warn(`[classifier] Unexpected result "${label}", using fallback`)
        return fallback(config.classifier.complexity)
    } catch (err) {
        console.error('[classifier] Classification failed:', (err as Error).message)
        return fallback(config.classifier.complexity)
    }
}

export { stripHtml }
