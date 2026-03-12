import Anthropic from '@anthropic-ai/sdk'
import { env } from './config.js'
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

function buildClassifierPrompt(complexity: Record<string, string>): string {
    const labels = Object.keys(complexity)
    const definitions = Object.entries(complexity)
        .map(([label, description]) => `- ${label}: ${description}`)
        .join('\n')

    return `Classify this software engineering task into exactly one of the following categories.

${definitions}

YOU MUST Respond with a JSON object with exactly two fields, no explanations or extra text outside the JSON object:
- "result": one of ${labels.map((l) => `"${l}"`).join(', ')}
- "reason": one sentence explaining why you chose that category

Example: {"result": "${labels[0]}", "reason": "This task involves..."}`
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

    // Extract model ID from "provider/model-id"
    const modelId = modelString.split('/').slice(1).join('/')

    const description = stripHtml(issue.description_html)
    const userContent = `Task title: ${issue.name}\nTask description: ${description.slice(0, 1000)}`
    const systemPrompt = buildClassifierPrompt(config.classifier.complexity)
    const validLabels = Object.keys(config.classifier.complexity)

    try {
        const client = new Anthropic({ apiKey: env.anthropicApiKey })
        const response = await client.messages.create({
            model: modelId,
            max_tokens: 128,
            messages: [
                {
                    role: 'user',
                    content: `${systemPrompt}\n\n${userContent}`,
                },
            ],
        })

        const firstContent = response.content[0]
        const text =
            firstContent?.type === 'text' ? firstContent.text.trim() : ''

        // Parse JSON response
        const parsed = JSON.parse(text) as { result?: string; reason?: string }
        const result = parsed.result?.trim().toLowerCase() ?? ''
        const reason = parsed.reason?.trim() ?? ''

        if (validLabels.includes(result)) {
            console.log(`[classifier] "${issue.name}" → ${result}: ${reason}`)
            return { result, reason }
        }

        console.warn(`[classifier] Unexpected result "${result}", using fallback`)
        return fallback(config.classifier.complexity)
    } catch (err) {
        console.error('[classifier] Classification failed:', (err as Error).message)
        return fallback(config.classifier.complexity)
    }
}

export { stripHtml }
