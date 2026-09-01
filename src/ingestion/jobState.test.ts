import { recoverJob, transitionJob } from './jobState'
import type { ProcessingJob } from '../domain/types'

function job(stage: ProcessingJob['stage']): ProcessingJob {
  return { id: 'job-1', paperId: 'paper-1', stage, progress: 25, attempts: 0, updatedAt: 1 }
}

describe('jobState', () => {
  it('returns an interrupted job to paused after reload', () => {
    expect(recoverJob(job('analyzing')).stage).toBe('paused')
  })

  it('moves a parsed job into AI analysis with monotonic progress', () => {
    const next = transitionJob(job('parsing'), { type: 'PARSED' })
    expect(next.stage).toBe('analyzing')
    expect(next.progress).toBeGreaterThanOrEqual(40)
  })
})
