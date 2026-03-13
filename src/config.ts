import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SukhoiConfig } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '..', 'sukhoi.config.json')

const DEFAULT_PROMPT =
  'You are an autonomous coding agent. You are given a task from a project management system.\n\n' +
  'Your job:\n' +
  '1. Read the task description carefully.\n' +
  '2. Explore the codebase to understand existing patterns and conventions before making changes.\n' +
  '3. Implement the required changes with minimal, focused modifications.\n' +
  '4. Ensure code quality — run `pnpm typecheck` before finishing.\n' +
  '5. Only modify files relevant to the task. Do not refactor unrelated code.\n' +
  '6. Follow the existing code style, naming conventions, and file structure.\n\n' +
  'The task will be provided below with its full context.'

function validate(raw: unknown): SukhoiConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('sukhoi.config.json must be a JSON object')
  }
  const cfg = raw as Record<string, unknown>

  if (typeof cfg['repo'] !== 'string' || !cfg['repo']) {
    throw new Error('sukhoi.config.json: "repo" must be a non-empty string')
  }

  const baseBranch =
    typeof cfg['baseBranch'] === 'string' && cfg['baseBranch']
      ? cfg['baseBranch']
      : 'main'

  const prompt =
    typeof cfg['prompt'] === 'string' && cfg['prompt']
      ? cfg['prompt']
      : DEFAULT_PROMPT

  if (typeof cfg['models'] !== 'object' || cfg['models'] === null) {
    throw new Error('sukhoi.config.json: "models" must be an object')
  }
  const models = cfg['models'] as Record<string, unknown>
  for (const [alias, value] of Object.entries(models)) {
    if (typeof value !== 'string') {
      throw new Error(`sukhoi.config.json: models["${alias}"] must be a string`)
    }
  }

  const defaultModel =
    typeof cfg['defaultModel'] === 'string' ? cfg['defaultModel'] : 'sonnet'
  if (!(defaultModel in models)) {
    throw new Error(
      `sukhoi.config.json: defaultModel "${defaultModel}" not found in models`
    )
  }

  const DEFAULT_COMPLEXITY: Record<string, string> = {
    boilerplate:
      'Repetitive or standard code. Examples: CRUD endpoints, config files, adding fields to existing patterns, simple UI components that mirror existing ones.',
    typical:
      'Standard SWE work. Examples: implementing a well-defined feature, API endpoint with business logic, database queries, unit tests, integrating a known library.',
    complex:
      'Requires architectural thinking or significant design decisions. Examples: multi-step user flows, security-critical features (auth, permissions), data migrations, system design, cross-cutting concerns.',
  }

  const classifier = (() => {
    const raw = cfg['classifier'] as Record<string, unknown> | undefined
    const model =
      typeof raw?.['model'] === 'string' ? raw['model'] : defaultModel
    if (!(model in models)) {
      throw new Error(
        `sukhoi.config.json: classifier.model "${model}" not found in models`
      )
    }
    const enabled =
      typeof raw?.['enabled'] === 'boolean' ? raw['enabled'] : true

    // complexity: user-defined map of label → description
    // Falls back to built-in boilerplate/typical/complex if not set
    const rawComplexity = raw?.['complexity']
    let complexity: Record<string, string>
    if (
      typeof rawComplexity === 'object' &&
      rawComplexity !== null &&
      !Array.isArray(rawComplexity)
    ) {
      const entries = Object.entries(rawComplexity as Record<string, unknown>)
      if (entries.length === 0) {
        throw new Error('sukhoi.config.json: classifier.complexity must not be empty')
      }
      for (const [label, desc] of entries) {
        if (typeof desc !== 'string') {
          throw new Error(
            `sukhoi.config.json: classifier.complexity["${label}"] must be a string`
          )
        }
      }
      complexity = rawComplexity as Record<string, string>
    } else {
      complexity = DEFAULT_COMPLEXITY
    }

    return { model, enabled, complexity }
  })()

  if (!Array.isArray(cfg['routing'])) {
    throw new Error('sukhoi.config.json: "routing" must be an array')
  }
  const routing = cfg['routing'] as Array<Record<string, unknown>>
  for (const rule of routing) {
    if (typeof rule['model'] !== 'string' || !(rule['model'] in models)) {
      throw new Error(
        `sukhoi.config.json: routing rule "${rule['name']}" references unknown model "${rule['model']}"`
      )
    }
    const match = rule['match'] as Record<string, unknown> | undefined
    if (match) {
      if (match['complexity'] !== undefined && !Array.isArray(match['complexity'])) {
        throw new Error(
          `sukhoi.config.json: routing rule "${rule['name']}" match.complexity must be an array`
        )
      }
      if (match['priority'] !== undefined && !Array.isArray(match['priority'])) {
        throw new Error(
          `sukhoi.config.json: routing rule "${rule['name']}" match.priority must be an array`
        )
      }
      if (match['labels'] !== undefined && !Array.isArray(match['labels'])) {
        throw new Error(
          `sukhoi.config.json: routing rule "${rule['name']}" match.labels must be an array`
        )
      }
    }
  }

  return {
    repo: cfg['repo'] as string,
    baseBranch,
    prompt,
    classifier,
    models: models as Record<string, string>,
    routing: cfg['routing'] as SukhoiConfig['routing'],
    defaultModel,
  }
}

let _config: SukhoiConfig | null = null

export function loadConfig(): SukhoiConfig {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as unknown
  _config = validate(raw)
  return _config
}

export function getConfig(): SukhoiConfig {
  if (!_config) return loadConfig()
  return _config
}

// Hot reload: watch config file for changes
export function watchConfig(onChange: (cfg: SukhoiConfig) => void): void {
  fs.watch(CONFIG_PATH, () => {
    try {
      const cfg = loadConfig()
      console.log('[config] Reloaded sukhoi.config.json')
      onChange(cfg)
    } catch (err) {
      console.error('[config] Failed to reload config:', (err as Error).message)
    }
  })
}

// ── Environment variables ────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required environment variable: ${key}`)
  return val
}

export const env = {
  get planeApiKey() { return requireEnv('PLANE_API_KEY') },
  get planeBaseUrl() { return requireEnv('PLANE_BASE_URL') },
  get planeWorkspaceSlug() { return requireEnv('PLANE_WORKSPACE_SLUG') },
  get planeProjectId() { return requireEnv('PLANE_PROJECT_ID') },
  get webhookSecret() { return requireEnv('WEBHOOK_SECRET') },
  get githubToken() { return requireEnv('GITHUB_TOKEN') },
  get anthropicApiKey() { return process.env['ANTHROPIC_API_KEY'] ?? '' },
  get openaiApiKey() { return process.env['OPENAI_API_KEY'] ?? '' },
  get openrouterApiKey() { return process.env['OPENROUTER_API_KEY'] ?? '' },
  get port() { return parseInt(process.env['PORT'] ?? '3000', 10) },
  get concurrency() { return parseInt(process.env['CONCURRENCY'] ?? '1', 10) },
  get jobTimeoutMs() { return parseInt(process.env['JOB_TIMEOUT_MS'] ?? '600000', 10) },
  // Optional: path to an opencode config file inside the container.
  // When set, the file is copied to ~/.config/opencode/config.json before each job.
  get opencodeConfigPath() { return process.env['OPENCODE_CONFIG_PATH'] ?? '' },
}
