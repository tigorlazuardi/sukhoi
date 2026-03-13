import http from 'node:http'
import { env, getConfig, watchConfig } from './config.js'
import { addComment, getIssue, getStateId } from './plane.js'
import { buildQueuedComment } from './prompt.js'
import { JobQueue } from './queue.js'
import { processJob } from './worker.js'
import { createWebhookHandler, setTodoStateId } from './webhook.js'
import type { Job } from './types.js'

async function main(): Promise<void> {
  // ── Load config ────────────────────────────────────────────────────────────
  const config = getConfig()
  console.log(`[sukhoi] Loaded config — repo: ${config.repo}, baseBranch: ${config.baseBranch}`)

  // ── Set up job queue ───────────────────────────────────────────────────────
  const queue = new JobQueue(env.concurrency)
  queue.setHandler(async (job: Job) => {
    await processJob(job)
  })

  // ── Discover Todo state UUID from Plane ────────────────────────────────────
  const projectId = env.planeProjectId
  try {
    const todoId = await getStateId(projectId, config.states.todo)
    setTodoStateId(todoId)
  } catch (err) {
    console.error('[sukhoi] Failed to fetch Plane states:', (err as Error).message)
    console.error('[sukhoi] Set PLANE_TODO_STATE_ID env var as fallback')
    process.exit(1)
  }

  // ── Watch config for hot reload ────────────────────────────────────────────
  watchConfig((cfg) => {
    console.log(
      `[sukhoi] Config reloaded — defaultModel: ${cfg.defaultModel}, routes: ${cfg.routing.length}`
    )
  })

  // ── Create webhook handler ─────────────────────────────────────────────────
  const handleRequest = createWebhookHandler(({ issueId, projectId }) => {
    const job = queue.enqueue(issueId, projectId)
    // Post acknowledgement comment immediately — fire and forget
    getIssue(projectId, issueId)
      .then((issue) => {
        const queueDepth = queue.depth + queue.activeCount
        const comment = buildQueuedComment(issue, queueDepth)
        return addComment(projectId, issueId, comment)
      })
      .catch((err: unknown) => {
        console.warn(`[sukhoi] Could not post queued comment for job ${job.id}:`, (err as Error).message)
      })
  })

  // ── Start HTTP server ──────────────────────────────────────────────────────
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', queue: { active: queue.activeCount, pending: queue.depth } }))
      return
    }
    handleRequest(req, res).catch((err: unknown) => {
      console.error('[sukhoi] Unhandled error in request handler:', err)
      if (!res.headersSent) {
        res.writeHead(500)
        res.end('Internal Server Error')
      }
    })
  })

  server.listen(env.port, () => {
    console.log(`[sukhoi] Listening on :${env.port}`)
    console.log(`[sukhoi] Webhook endpoint: POST http://0.0.0.0:${env.port}/webhook`)
  })

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = (): void => {
    console.log('[sukhoi] Shutting down...')
    server.close(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('[sukhoi] Fatal error:', err)
  process.exit(1)
})
