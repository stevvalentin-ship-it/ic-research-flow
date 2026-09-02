import type { PaperAnalysis, PaperRecord } from '../domain/types'

export interface RelatednessEdge {
  source: string
  target: string
  weight: number
  relation: 'related'
}

function tokenize(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ').split(' ').filter((token) => token.length > 1)
}

function weightedTerms(paper: PaperRecord, analysis: PaperAnalysis | undefined): Map<string, number> {
  const terms = new Map<string, number>()
  const bump = (value: unknown, weight: number) => {
    for (const token of tokenize(typeof value === 'string' ? value : '')) {
      terms.set(token, (terms.get(token) ?? 0) + weight)
    }
  }
  bump(paper.title, 5)
  bump(paper.abstract ?? '', 3)
  bump(paper.fullText, 1)
  if (analysis) {
    for (const keyword of analysis.keywordsZh ?? []) bump(keyword, 4)
    for (const keyword of analysis.keywordsEn ?? []) bump(keyword, 4)
    for (const domain of (analysis.domains ?? []).map((item) => item.domain)) bump(domain, 2)
    const facets = analysis.facets ?? ({} as PaperAnalysis['facets'])
    for (const key of ['objects', 'problems', 'methods', 'processNodes', 'metrics', 'applications', 'findings', 'limitations'] as const) {
      for (const value of facets[key] ?? []) bump(value, 3)
    }
  }
  return terms
}

function cosine(left: Map<string, number>, right: Map<string, number>): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (const [term, weight] of left) {
    leftNorm += weight * weight
    const other = right.get(term)
    if (other) dot += weight * other
  }
  for (const weight of right.values()) rightNorm += weight * weight
  if (!leftNorm || !rightNorm) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

export function computeRelatednessEdges(papers: PaperRecord[], analyses: PaperAnalysis[]): RelatednessEdge[] {
  const byPaper = new Map(analyses.map((analysis) => [analysis.paperId, analysis]))
  const vectors = papers.map((paper) => ({ id: paper.id, terms: weightedTerms(paper, byPaper.get(paper.id)) }))
  const edges: RelatednessEdge[] = []
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      const weight = cosine(vectors[i].terms, vectors[j].terms)
      if (weight >= 0.08) {
        edges.push({ source: vectors[i].id, target: vectors[j].id, weight, relation: 'related' })
      }
    }
  }
  return edges.sort((a, b) => b.weight - a.weight)
}
