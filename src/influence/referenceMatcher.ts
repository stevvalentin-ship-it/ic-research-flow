import type { PaperAnalysis, PaperRecord } from '../domain/types'

const normalizeDoi = (value?: string) => value?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim().toLowerCase()
const normalizeTitle = (value: string) => value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ').replace(/\s+/g, ' ').trim()

function tokens(title: string): Set<string> {
  return new Set(normalizeTitle(title).split(' ').filter((token) => token.length > 1))
}

function titleSimilarity(left: string, right: string): number {
  const a = tokens(left)
  const b = tokens(right)
  if (!a.size || !b.size) return 0
  const intersection = [...a].filter((token) => b.has(token)).length
  const union = new Set([...a, ...b]).size
  const overlap = intersection / Math.min(a.size, b.size)
  const jaccard = intersection / union
  return 0.6 * overlap + 0.4 * jaccard
}

export function matchLocalReferences(papers: PaperRecord[], analyses: PaperAnalysis[]): PaperAnalysis[] {
  const byDoi = new Map(papers.filter((paper) => paper.doi).map((paper) => [normalizeDoi(paper.doi), paper.id]))
  const titles = papers.map((paper) => ({ id: paper.id, title: paper.title }))
  const findTitleMatch = (referenceTitle: string): string | undefined => {
    const exact = titles.find((paper) => normalizeTitle(paper.title) === normalizeTitle(referenceTitle))
    if (exact) return exact.id
    let bestId: string | undefined
    let bestScore = 0.72
    for (const paper of titles) {
      const score = titleSimilarity(referenceTitle, paper.title)
      if (score >= bestScore) {
        bestScore = score
        bestId = paper.id
      }
    }
    return bestId
  }
  return analyses.map((analysis) => ({
    ...analysis,
    references: analysis.references.map((reference) => {
      const matchedPaperId = (reference.doi ? byDoi.get(normalizeDoi(reference.doi)) : undefined)
        ?? findTitleMatch(reference.title)
      return matchedPaperId && matchedPaperId !== analysis.paperId
        ? { ...reference, matchedPaperId, confidence: reference.doi ? 1 : 0.82 }
        : reference
    }),
  }))
}
