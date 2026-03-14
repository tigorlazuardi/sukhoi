import { randomUUID } from 'node:crypto'
import type { Job } from './types.js'

type JobHandler = (job: Job) => Promise<void>

export class JobQueue {
  private queue: Job[] = []
  private running = 0
  private readonly concurrency: number
  private handler: JobHandler | null = null
  private readonly activeControllers = new Set<AbortController>()

  constructor(concurrency = 1) {
    this.concurrency = concurrency
  }

  setHandler(handler: JobHandler): void {
    this.handler = handler
  }

  enqueue(issueId: string, projectId: string): Job {
    const controller = new AbortController()
    const job: Job = {
      id: randomUUID(),
      issueId,
      projectId,
      enqueuedAt: new Date(),
      signal: controller.signal,
    }
    // Store controller alongside job so we can abort pending jobs too
    ;(job as Job & { _controller: AbortController })._controller = controller
    this.queue.push(job)
    console.log(
      `[queue] Enqueued job ${job.id} for issue ${issueId} (queue depth: ${this.queue.length})`
    )
    this.drain()
    return job
  }

  /** Abort all active (running) jobs immediately. Pending jobs are dropped. */
  killActive(): void {
    // Drop pending jobs
    this.queue.length = 0
    // Abort running jobs
    for (const controller of this.activeControllers) {
      controller.abort()
    }
  }

  private drain(): void {
    if (!this.handler) return
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!
      const controller = (job as Job & { _controller: AbortController })._controller
      this.running++
      this.activeControllers.add(controller)
      console.log(`[queue] Starting job ${job.id} (running: ${this.running})`)
      this.handler(job)
        .catch((err: unknown) => {
          console.error(`[queue] Job ${job.id} threw unhandled error:`, err)
        })
        .finally(() => {
          this.running--
          this.activeControllers.delete(controller)
          console.log(
            `[queue] Job ${job.id} finished (running: ${this.running})`
          )
          this.drain()
        })
    }
  }

  get depth(): number {
    return this.queue.length
  }

  get activeCount(): number {
    return this.running
  }
}
