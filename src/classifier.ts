import Anthropic from '@anthropic-ai/sdk'
import { env } from './config.js'
import type { Complexity, PlaneIssue, SukhoiConfig } from './types.js'

const VALID: Complexity[] = ['boilerplate', 'typical', 'complex']

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

const CLASSIFIER_PROMPT = `Classify this software engineering task into exactly one category.

- boilerplate: Repetitive or standard code. Examples: CRUD endpoints, config files, adding fields to existing patterns, simple UI components that mirror existing ones.
- typical: Standard SWE work. Examples: implementing a well-defined feature, API endpoint with business logic, database queries, unit tests, integrating a known library.
- complex: Requires architectural thinking or significant design decisions. Examples: multi-step user flows (onboarding, checkout, payment), security-critical features (auth, permissions), data migrations, system design, cross-cutting concerns.

Reply with exactly one word: boilerplate, typical, or complex.`

export async function classifyComplexity(
  issue: PlaneIssue,
  config: SukhoiConfig
): Promise<Complexity> {
  if (!config.classifier.enabled) {
    return 'typical'
  }

  const modelString = config.models[config.classifier.model]
  if (!modelString) {
    console.warn('[classifier] classifier.model not found in models, defaulting to typical')
    return 'typical'
  }

  // Extract the model ID from "provider/model-id"
  const modelId = modelString.split('/').slice(1).join('/')

  const description = stripHtml(issue.description_html)
  const userContent = `Task title: ${issue.name}\nTask description: ${description.slice(0, 1000)}`

  try {
    const client = new Anthropic({ apiKey: env.anthropicApiKey })
    const response = await client.messages.create({
      model: modelId,
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: `${CLASSIFIER_PROMPT}\n\n${userContent}`,
        },
      ],
    })

    const firstContent = response.content[0]
    const text =
      firstContent.type === 'text'
        ? firstContent.text.trim().toLowerCase()
        : ''

    if ((VALID as string[]).includes(text)) {
      console.log(`[classifier] "${issue.name}" → ${text}`)
      return text as Complexity
    }

    console.warn(`[classifier] Unexpected response "${text}", defaulting to typical`)
    return 'typical'
  } catch (err) {
    console.error('[classifier] Classification failed:', (err as Error).message)
    return 'typical' // safe fallback
  }
}

export { stripHtml }
