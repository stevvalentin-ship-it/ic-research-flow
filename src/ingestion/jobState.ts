import type { ProcessingJob } from '../domain/types'

export type JobEvent =
  | { type: 'START' }
  | { type: 'PARSED' }
  | { type: 'ANALYZED' }
  | { type: 'INDEXED' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'FAIL'; code: string; message: string }
  | { type: 'RETRY' }

const activeStages = new Set<ProcessingJob['stage']>(['parsing', 'analyzing', 'indexing'])

export function recoverJob(job: ProcessingJob): ProcessingJob {
  return activeStages.has(job.stage) ? { ...job, stage: 'paused', updatedAt: Date.now() } : job
}

export function transitionJob(job: ProcessingJob, event: JobEvent): ProcessingJob {
  const base = { ...job, updatedAt: Date.now(), errorCode: undefined, errorMessage: undefined }
  switch (event.type) {
    case 'START': return { ...base, stage: 'parsing', progress: Math.max(5, job.progress) }
    case 'PARSED': return { ...base, stage: 'analyzing', progress: Math.max(40, job.progress) }
    case 'ANALYZED': return { ...base, stage: 'indexing', progress: Math.max(80, job.progress) }
    case 'INDEXED': return { ...base, stage: 'completed', progress: 100 }
    case 'PAUSE': return { ...base, stage: 'paused' }
    case 'RESUME': return { ...base, stage: 'queued' }
    case 'RETRY': return { ...base, stage: 'queued', progress: 0, attempts: job.attempts + 1 }
    case 'FAIL': return { ...base, stage: 'failed', errorCode: event.code, errorMessage: event.message }
  }
}
