import { randomUUID } from 'node:crypto'
import type { Job } from './types.js'

type JobHandler = (job: Job) => Promise<void>

export class JobQueue {
  private queue: Job[] = []
  private running = 0
  private readonly concurrency: number
  private handler: JobHandler | null = null

  constructor(concurrency = 1) {
    this.concurrency = concurrency
  }

  setHandler(handler: JobHandler): void {
    this.handler = handler
  }

  enqueue(issueId: string, projectId: string): Job {
    const job: Job = {
      id: randomUUID(),
      issueId,
      projectId,
      enqueuedAt: new Date(),
    }
    this.queue.push(job)
    console.log(
      `[queue] Enqueued job ${job.id} for issue ${issueId} (queue depth: ${this.queue.length})`
    )
    this.drain()
    return job
  }

  private drain(): void {
    if (!this.handler) return
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!
      this.running++
      console.log(`[queue] Starting job ${job.id} (running: ${this.running})`)
      this.handler(job)
        .catch((err: unknown) => {
          console.error(`[queue] Job ${job.id} threw unhandled error:`, err)
        })
        .finally(() => {
          this.running--
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
