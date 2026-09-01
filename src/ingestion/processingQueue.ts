import type { ProcessingJob } from '../domain/types'
import { transitionJob } from './jobState'

export interface ProcessingQueueHandlers<TParsed = unknown, TAnalysis = unknown> {
  persist(job: ProcessingJob): Promise<void>
  parse(job: ProcessingJob): Promise<TParsed>
  analyze(job: ProcessingJob, parsed: TParsed): Promise<TAnalysis>
  index(job: ProcessingJob, parsed: TParsed, analysis: TAnalysis): Promise<void>
}

export class ProcessingQueue<TParsed = unknown, TAnalysis = unknown> {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly handlers: ProcessingQueueHandlers<TParsed, TAnalysis>) {}

  enqueue(job: ProcessingJob): Promise<void> {
    const run = this.tail.then(() => this.run(job))
    this.tail = run.catch(() => undefined)
    return run
  }

  private async run(initialJob: ProcessingJob): Promise<void> {
    let job = transitionJob(initialJob, { type: 'START' })
    await this.handlers.persist(job)
    try {
      const parsed = await this.handlers.parse(job)
      job = transitionJob(job, { type: 'PARSED' })
      await this.handlers.persist(job)

      const analysis = await this.handlers.analyze(job, parsed)
      job = transitionJob(job, { type: 'ANALYZED' })
      await this.handlers.persist(job)

      await this.handlers.index(job, parsed, analysis)
      job = transitionJob(job, { type: 'INDEXED' })
      await this.handlers.persist(job)
    } catch (error) {
      job = transitionJob(job, {
        type: 'FAIL',
        code: error instanceof Error && 'code' in error ? String(error.code) : 'PROCESSING_FAILED',
        message: error instanceof Error ? error.message : 'Unknown processing error',
      })
      await this.handlers.persist(job)
      throw error
    }
  }
}
