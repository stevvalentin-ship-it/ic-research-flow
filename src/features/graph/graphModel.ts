import type { CitationRelation, PaperAnalysis, PaperRecord, PaperRole, PaperScore } from '../../domain/types'
import { computeRelatednessEdges } from '../../influence/relatedness'

export interface GraphPaperNode { id: string; title: string; year?: number; role: PaperRole; score: number }
export type GraphEdgeRelation = CitationRelation | 'related'
export interface GraphCitationEdge { source: string; target: string; relation: GraphEdgeRelation; weight: number }

const weights: Record<CitationRelation, number> = { foundation: 1.25, extends: 1.1, validates: 1, contradicts: 1, background: 0.55 }

export function buildInfluenceGraph(papers: PaperRecord[], analyses: PaperAnalysis[], scores: PaperScore[]) {
  const scoreById = new Map(scores.map((score) => [score.paperId, score]))
  const ids = new Set(papers.map((paper) => paper.id))
  const nodes: GraphPaperNode[] = papers.map((paper) => ({ id: paper.id, title: paper.title, year: paper.year, role: scoreById.get(paper.id)?.role ?? 'foundation', score: scoreById.get(paper.id)?.total ?? 0 }))
  const edgeMap = new Map<string, GraphCitationEdge>()
  const edgeKey = (source: string, target: string) => `${source}->${target}`
  const addEdge = (source: string, target: string, relation: GraphEdgeRelation, weight: number) => {
    const key = edgeKey(source, target)
    const existing = edgeMap.get(key)
    if (!existing || existing.weight < weight) {
      edgeMap.set(key, { source, target, relation: existing && existing.relation !== 'related' ? existing.relation : relation, weight })
    }
  }
  analyses.filter((analysis) => ids.has(analysis.paperId)).forEach((analysis) => {
    analysis.references
      .filter((reference) => reference.matchedPaperId && ids.has(reference.matchedPaperId))
      .forEach((reference) => addEdge(analysis.paperId, reference.matchedPaperId!, reference.relation, weights[reference.relation]))
  })
  for (const edge of computeRelatednessEdges(papers, analyses)) {
    if (ids.has(edge.source) && ids.has(edge.target)) {
      addEdge(edge.source, edge.target, 'related', edge.weight)
    }
  }
  return { nodes, edges: [...edgeMap.values()].sort((a, b) => b.weight - a.weight) }
}
