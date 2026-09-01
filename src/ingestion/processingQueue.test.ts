import type { ProcessingJob } from '../domain/types'
import { ProcessingQueue } from './processingQueue'

const makeJob = (id: string): ProcessingJob => ({
  id,
  paperId: id,
  stage: 'queued',
  progress: 0,
  attempts: 0,
  updatedAt: 0,
})

describe('ProcessingQueue', () => {
  it('runs jobs sequentially and persists every completed transition', async () => {
    const calls: string[] = []
    const queue = new ProcessingQueue({
      persist: async (job) => { calls.push(`${job.id}:${job.stage}`) },
      parse: async (job) => { calls.push(`${job.id}:parse`); return { text: job.id } },
      analyze: async (job) => { calls.push(`${job.id}:analyze`); return { summary: job.id } },
      index: async (job) => { calls.push(`${job.id}:index`) },
    })

    await Promise.all([queue.enqueue(makeJob('a')), queue.enqueue(makeJob('b'))])

    expect(calls.indexOf('a:index')).toBeLessThan(calls.indexOf('b:parse'))
    expect(calls).toEqual(expect.arrayContaining(['a:completed', 'b:completed']))
  })
})
