import { ResearchDatabase } from './database'
import { PaperRepository } from './paperRepository'
import type { PaperRecord } from '../domain/types'

function makePaper(overrides: Partial<PaperRecord> = {}): PaperRecord {
  return {
    id: 'paper-1',
    fileName: 'paper.pdf',
    fileSize: 4,
    blob: new Blob(['test'], { type: 'application/pdf' }),
    pageCount: 1,
    createdAt: 1,
    updatedAt: 1,
    title: 'A test paper',
    authors: [],
    year: 2025,
    fullText: 'test',
    pageTexts: ['test'],
    analysisStatus: 'queued',
    analysisVersion: 1,
    ...overrides,
  }
}

describe('PaperRepository', () => {
  it('deduplicates papers by SHA-256 id', async () => {
    const db = new ResearchDatabase('repo-dedupe-test')
    const repository = new PaperRepository(db)
    await repository.put(makePaper({ id: 'same' }))
    await repository.put(makePaper({ id: 'same', fileName: 'renamed.pdf' }))

    expect(await repository.count()).toBe(1)
    expect((await repository.get('same'))?.fileName).toBe('renamed.pdf')
    await db.delete()
  })

  it('lists the most recently updated papers first', async () => {
    const db = new ResearchDatabase('repo-sort-test')
    const repository = new PaperRepository(db)
    await repository.put(makePaper({ id: 'older', updatedAt: 10 }))
    await repository.put(makePaper({ id: 'newer', updatedAt: 20 }))

    expect((await repository.list()).map((paper) => paper.id)).toEqual(['newer', 'older'])
    await db.delete()
  })
})
