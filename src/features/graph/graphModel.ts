import type { CitationRelation, PaperAnalysis, PaperRecord, PaperRole, PaperScore } from '../../domain/types'

export interface GraphPaperNode { id: string; title: string; year?: number; role: PaperRole; score: number }
export interface GraphCitationEdge { source: string; target: string; relation: CitationRelation; weight: number }

const weights: Record<CitationRelation, number> = { foundation: 1.25, extends: 1.1, validates: 1, contradicts: 1, background: 0.55 }

export function buildInfluenceGraph(papers: PaperRecord[], analyses: PaperAnalysis[], scores: PaperScore[]) {
  const scoreById = new Map(scores.map((score) => [score.paperId, score]))
  const ids = new Set(papers.map((paper) => paper.id))
  const nodes: GraphPaperNode[] = papers.map((paper) => ({ id: paper.id, title: paper.title, year: paper.year, role: scoreById.get(paper.id)?.role ?? 'foundation', score: scoreById.get(paper.id)?.total ?? 0 }))
  const edges: GraphCitationEdge[] = analyses.flatMap((analysis) => analysis.references
    .filter((reference) => reference.matchedPaperId && ids.has(reference.matchedPaperId))
    .map((reference) => ({ source: analysis.paperId, target: reference.matchedPaperId!, relation: reference.relation, weight: weights[reference.relation] })))
  return { nodes, edges }
}
