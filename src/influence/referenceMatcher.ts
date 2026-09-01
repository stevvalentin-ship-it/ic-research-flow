import type { PaperAnalysis, PaperRecord } from '../domain/types'

const normalizeDoi = (value?: string) => value?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim().toLowerCase()
const normalizeTitle = (value: string) => value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '')

export function matchLocalReferences(papers: PaperRecord[], analyses: PaperAnalysis[]): PaperAnalysis[] {
  const byDoi = new Map(papers.filter((paper) => paper.doi).map((paper) => [normalizeDoi(paper.doi), paper.id]))
  const byTitle = new Map(papers.map((paper) => [normalizeTitle(paper.title), paper.id]))
  return analyses.map((analysis) => ({
    ...analysis,
    references: analysis.references.map((reference) => {
      const matchedPaperId = (reference.doi ? byDoi.get(normalizeDoi(reference.doi)) : undefined)
        ?? byTitle.get(normalizeTitle(reference.title))
      return matchedPaperId && matchedPaperId !== analysis.paperId
        ? { ...reference, matchedPaperId, confidence: reference.doi ? 1 : 0.9 }
        : reference
    }),
  }))
}
