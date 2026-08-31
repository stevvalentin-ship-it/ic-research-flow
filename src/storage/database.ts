import Dexie, { type EntityTable } from 'dexie'
import type { PaperAnalysis, PaperRecord, ProcessingJob, QueryCacheRecord } from '../domain/types'

export class ResearchDatabase extends Dexie {
  papers!: EntityTable<PaperRecord, 'id'>
  analyses!: EntityTable<PaperAnalysis, 'paperId'>
  jobs!: EntityTable<ProcessingJob, 'id'>
  queryCache!: EntityTable<QueryCacheRecord, 'key'>

  constructor(name = 'ic-research-flow') {
    super(name)
    this.version(1).stores({
      papers: 'id, updatedAt, analysisStatus, year, title',
      analyses: 'paperId, analyzedAt, *keywordsZh, *keywordsEn',
      jobs: 'id, paperId, stage, updatedAt',
      queryCache: 'key, updatedAt',
    })
  }
}

export const researchDatabase = new ResearchDatabase()
