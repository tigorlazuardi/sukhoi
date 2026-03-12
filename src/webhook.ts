import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { env } from './config.js'
import type { PlaneIssue, PlaneWebhookPayload } from './types.js'

// ── Signature verification ───────────────────────────────────────────────────
// Plane uses HMAC-SHA256(secret, JSON.stringify(body))
// Header: X-Plane-Signature

function verifySignature(rawBody: string, signature: string): boolean {
  const expected = crypto
    .createHmac('sha256', env.webhookSecret)
    .update(rawBody)
    .digest('hex')
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(signature, 'hex')
  )
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

// ── Webhook event filter ──────────────────────────────────────────────────────

export interface TriggerEvent {
  issueId: string
  projectId: string
}

export type WebhookHandler = (event: TriggerEvent) => void

// Returns the state UUID we need to watch for to trigger the agent.
// We look for issues whose state transitions to the Plane "Todo" state.
// The webhook payload contains the full issue, including the state UUID.
// We accept the state UUID via env or discover it from the first matching payload.
let todoStateId: string | null = process.env['PLANE_TODO_STATE_ID'] ?? null

export function setTodoStateId(id: string): void {
  todoStateId = id
  console.log(`[webhook] Watching for state transitions to Todo (${id})`)
}

export function createWebhookHandler(onTrigger: WebhookHandler) {
  return async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // ── Route ────────────────────────────────────────────────────────────────
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404)
      res.end('Not Found')
      return
    }

    // ── Read body ────────────────────────────────────────────────────────────
    let rawBody: string
    try {
      rawBody = await readBody(req)
    } catch {
      res.writeHead(400)
      res.end('Bad Request')
      return
    }

    // ── Verify signature ──────────────────────────────────────────────────────
    const signature = req.headers['x-plane-signature'] as string | undefined
    if (!signature) {
      res.writeHead(401)
      res.end('Missing X-Plane-Signature')
      return
    }

    let valid: boolean
    try {
      valid = verifySignature(rawBody, signature)
    } catch {
      valid = false
    }

    if (!valid) {
      console.warn('[webhook] Invalid signature')
      res.writeHead(403)
      res.end('Invalid Signature')
      return
    }

    // ── Respond immediately (Plane expects 200 fast) ──────────────────────────
    res.writeHead(200)
    res.end('OK')

    // ── Parse payload ─────────────────────────────────────────────────────────
    let payload: PlaneWebhookPayload
    try {
      payload = JSON.parse(rawBody) as PlaneWebhookPayload
    } catch {
      console.error('[webhook] Failed to parse payload JSON')
      return
    }

    const event = req.headers['x-plane-event'] as string | undefined
    console.log(`[webhook] Received event: ${event ?? payload.event} / ${payload.action}`)

    // ── Filter: only issue update events ─────────────────────────────────────
    if (payload.event !== 'issue' || payload.action !== 'update') return

    const issue = payload.data as PlaneIssue
    if (!issue.state) return

    // ── Filter: only when state transitions to "Todo" ─────────────────────────
    if (!todoStateId) {
      console.warn(
        '[webhook] todoStateId not set yet — call setTodoStateId() at startup'
      )
      return
    }

    if (issue.state !== todoStateId) return

    console.log(
      `[webhook] Issue ${issue.id} (seq ${issue.sequence_id}) moved to Todo — triggering agent`
    )

    onTrigger({
      issueId: issue.id,
      projectId: issue.project,
    })
  }
}
