// ── Plane API types ──────────────────────────────────────────────────────────

export interface PlaneLabel {
  id: string
  name: string
  color: string
}

export interface PlaneIssue {
  id: string
  sequence_id: number
  name: string
  description_html: string | null
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none'
  state: string // UUID
  labels: PlaneLabel[]
  parent: { id: string; name: string } | null
  project: string // UUID
}

export interface PlaneState {
  id: string
  name: string
  group: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'
}

// ── Webhook payload ──────────────────────────────────────────────────────────

export interface PlaneWebhookPayload {
  event: string
  action: 'create' | 'update' | 'delete'
  webhook_id: string
  workspace_id: string
  data: PlaneIssue | { id: string }
}

// ── Config ───────────────────────────────────────────────────────────────────

// Complexity is now a user-defined string key from classifier.complexity config
export type Complexity = string

export interface RoutingRule {
  name: string
  match: {
    priority?: Array<'urgent' | 'high' | 'medium' | 'low' | 'none'>
    labels?: string[]
    complexity?: Complexity[]
  }
  model: string // alias key into config.models
}

export interface ClassifierConfig {
  model: string   // alias key into config.models
  enabled: boolean
  // Map of complexity label → description used in the classifier prompt.
  // Keys are the valid complexity values routing rules can reference.
  complexity: Record<string, string>
}

export interface WorklogConfig {
  enabled: boolean
  maxEntries: number // how many recent entries to keep on disk
}

export interface SukhoiConfig {
  repo: string
  baseBranch: string
  prompt: string
  classifier: ClassifierConfig
  models: Record<string, string> // alias → "provider/model"
  routing: RoutingRule[]
  defaultModel: string // alias key
  worklog?: WorklogConfig
}

// ── Job ──────────────────────────────────────────────────────────────────────

export interface Job {
  id: string
  issueId: string    // Plane issue UUID
  projectId: string  // Plane project UUID
  enqueuedAt: Date
}

// ── Runner result ────────────────────────────────────────────────────────────

export interface RunnerUsage {
  cost_usd: number
  tokens_input: number
  tokens_output: number
  tokens_cache_read: number
  tokens_cache_write: number
}

export interface RunnerResult {
  pr_url: string | null
  commit_url: string | null
  commit_sha: string | null
  branch: string | null
  model: string | null
  model_reason: string | null
  complexity: string | null
  complexity_reason: string | null
  skipped: boolean
  usage: RunnerUsage | null
}
