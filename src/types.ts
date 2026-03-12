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

export type Complexity = 'boilerplate' | 'typical' | 'complex'

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
  model: string // alias key into config.models
  enabled: boolean
}

export interface SukhoiConfig {
  repo: string
  baseBranch: string
  prompt: string
  classifier: ClassifierConfig
  models: Record<string, string> // alias → "provider/model"
  routing: RoutingRule[]
  defaultModel: string // alias key
}

// ── Job ──────────────────────────────────────────────────────────────────────

export interface Job {
  id: string
  issueId: string    // Plane issue UUID
  projectId: string  // Plane project UUID
  enqueuedAt: Date
}

// ── Runner result ────────────────────────────────────────────────────────────

export interface RunnerResult {
  pr_url: string | null
  commit_url: string | null
  commit_sha: string | null
  branch: string | null
  skipped: boolean
}
