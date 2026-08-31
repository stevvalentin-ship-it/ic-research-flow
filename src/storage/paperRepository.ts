import type { PaperRecord, AnalysisStatus } from '../domain/types'
import { researchDatabase, type ResearchDatabase } from './database'

export class PaperRepository {
  constructor(private readonly db: ResearchDatabase = researchDatabase) {}

  async put(paper: PaperRecord): Promise<string> {
    return this.db.papers.put(paper)
  }

  async get(id: string): Promise<PaperRecord | undefined> {
    return this.db.papers.get(id)
  }

  async list(): Promise<PaperRecord[]> {
    return this.db.papers.orderBy('updatedAt').reverse().toArray()
  }

  async count(): Promise<number> {
    return this.db.papers.count()
  }

  async remove(id: string): Promise<void> {
    await this.db.transaction('rw', [this.db.papers, this.db.analyses, this.db.jobs], async () => {
      await this.db.papers.delete(id)
      await this.db.analyses.delete(id)
      await this.db.jobs.where('paperId').equals(id).delete()
    })
  }

  async updateStatus(id: string, analysisStatus: AnalysisStatus): Promise<void> {
    await this.db.papers.update(id, { analysisStatus, updatedAt: Date.now() })
  }
}

export const paperRepository = new PaperRepository()
