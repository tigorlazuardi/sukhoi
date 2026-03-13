import { env } from './config.js'
import type { PlaneIssue, PlaneState } from './types.js'

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

export async function getIssue(
  projectId: string,
  issueId: string
): Promise<PlaneIssue> {
  return request<PlaneIssue>('GET', `/projects/${projectId}/issues/${issueId}/`)
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

// Minimal markdown → HTML for basic comment formatting
function markdownToHtml(md: string): string {
  return md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
    .split('\n')
    .map((line) => `<p>${line}</p>`)
    .join('\n')
}
