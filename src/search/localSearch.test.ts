import type { PaperRecord } from '../domain/types'
import { LocalPaperIndex } from './localSearch'

const paper = (index: number): PaperRecord => ({
  id: `p-${index}`,
  fileName: `${index}.pdf`,
  fileSize: 100,
  blob: new Blob(),
  pageCount: 1,
  createdAt: index,
  updatedAt: index,
  title: `Thermal TSV optimization ${index}`,
  authors: [],
  fullText: `chiplet thermal through silicon via benchmark ${index}`,
  pageTexts: [],
  analysisStatus: 'completed',
  analysisVersion: 1,
})

describe('LocalPaperIndex', () => {
  it('returns at most 50 candidates ordered by relevance', () => {
    const index = new LocalPaperIndex(Array.from({ length: 80 }, (_, i) => paper(i)))
    const results = index.search('thermal TSV', 50)

    expect(results).toHaveLength(50)
    expect(results.every((item, i) => i === 0 || results[i - 1].score >= item.score)).toBe(true)
  })
})
