import { marked } from 'marked'
import { env } from './config.js'
import type { PlaneIssue, PlaneLabel, PlaneState } from './types.js'

function baseUrl(): string {
  return `${env.planeBaseUrl}/api/v1/workspaces/${env.planeWorkspaceSlug}`
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  retries = 3,
  delayMs = 1000,
): Promise<T> {
  const url = `${baseUrl()}${path}`
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': env.planeApiKey,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Plane API ${method} ${url} → ${res.status}: ${text}`)
      }

      if (res.status === 204) return undefined as T
      return res.json() as Promise<T>
    } catch (err) {
      lastError = err as Error
      if (attempt < retries) {
        console.warn(`[plane] Request failed (attempt ${attempt}/${retries}): ${lastError.message} — retrying in ${delayMs}ms`)
        await new Promise((r) => setTimeout(r, delayMs * attempt))
      }
    }
  }

  throw lastError
}

// ── States ───────────────────────────────────────────────────────────────────

let _stateCache: Map<string, PlaneState> | null = null

export async function getStates(projectId: string): Promise<Map<string, PlaneState>> {
  if (_stateCache) return _stateCache

  const res = await request<{ results: PlaneState[] }>(
    'GET',
    `/projects/${projectId}/states/`
  )

  _stateCache = new Map(res.results.map((s) => [s.name, s]))
  return _stateCache
}

export async function getStateId(
  projectId: string,
  stateName: string
): Promise<string> {
  const states = await getStates(projectId)
  const state = states.get(stateName)
  if (!state) {
    throw new Error(
      `Plane state "${stateName}" not found. Available: ${[...states.keys()].join(', ')}`
    )
  }
  return state.id
}

// ── Issues ───────────────────────────────────────────────────────────────────

interface PlaneIssueRaw extends Omit<PlaneIssue, 'labels'> {
  labels: PlaneLabel[] | string[]
}

export async function getIssue(
  projectId: string,
  issueId: string
): Promise<PlaneIssue> {
  const raw = await request<PlaneIssueRaw>('GET', `/projects/${projectId}/issues/${issueId}/`)

  // Plane API returns labels as UUID strings; normalize to PlaneLabel objects
  // by fetching label details when needed.
  let labels: PlaneLabel[]
  if (raw.labels.length === 0 || typeof raw.labels[0] === 'object') {
    labels = raw.labels as PlaneLabel[]
  } else {
    const all = await getLabels(projectId)
    const ids = raw.labels as string[]
    labels = ids.flatMap((id) => {
      const found = all.get(id)
      return found ? [found] : []
    })
  }

  return { ...raw, labels }
}

let _labelCache: Map<string, PlaneLabel> | null = null

async function getLabels(projectId: string): Promise<Map<string, PlaneLabel>> {
  if (_labelCache) return _labelCache

  const res = await request<{ results: PlaneLabel[] }>(
    'GET',
    `/projects/${projectId}/labels/`
  )

  _labelCache = new Map(res.results.map((l) => [l.id, l]))
  return _labelCache
}

export async function updateIssueState(
  projectId: string,
  issueId: string,
  stateId: string
): Promise<void> {
  await request('PATCH', `/projects/${projectId}/issues/${issueId}/`, {
    state: stateId,
  })
}

// ── Comments ─────────────────────────────────────────────────────────────────

export async function addComment(
  projectId: string,
  issueId: string,
  markdown: string
): Promise<void> {
  await request('POST', `/projects/${projectId}/issues/${issueId}/comments/`, {
    comment_html: markdownToHtml(markdown),
  })
}

function markdownToHtml(md: string): string {
  return marked(md, { async: false }) as string
}
