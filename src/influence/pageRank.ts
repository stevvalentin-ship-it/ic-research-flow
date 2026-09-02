import type { CitationRelation } from '../domain/types'

export type GraphRelation = CitationRelation | 'related'

export interface InfluenceEdge {
  source: string
  target: string
  weight?: number
  relation?: GraphRelation
  selfCitation?: boolean
}

export interface InfluenceGraph {
  nodes: string[]
  edges: InfluenceEdge[]
  years?: Record<string, number | undefined>
}

const relationWeight: Record<GraphRelation, number> = {
  foundation: 1.25,
  extends: 1.1,
  validates: 1,
  contradicts: 1,
  background: 0.55,
  related: 0.85,
}

export function personalizedPageRank(
  graph: InfluenceGraph,
  personalization: Record<string, number>,
  options: { damping?: number; tolerance?: number; maxIterations?: number; currentYear?: number } = {},
): Record<string, number> {
  const { damping = 0.85, tolerance = 1e-8, maxIterations = 100, currentYear = new Date().getFullYear() } = options
  const nodes = [...new Set(graph.nodes)]
  if (!nodes.length) return {}
  const rawPersonalization = nodes.map((node) => Math.max(0, personalization[node] ?? 0))
  const pSum = rawPersonalization.reduce((sum, value) => sum + value, 0)
  const p = Object.fromEntries(nodes.map((node, i) => [node, pSum ? rawPersonalization[i] / pSum : 1 / nodes.length]))
  const outgoing = new Map<string, Array<{ target: string; weight: number }>>()
  for (const edge of graph.edges) {
    if (!(edge.source in p) || !(edge.target in p)) continue
    const age = Math.max(0, currentYear - (graph.years?.[edge.target] ?? currentYear))
    const recency = 0.7 + 0.3 * Math.exp(-age / 8)
    const weight = (edge.weight ?? 1) * relationWeight[edge.relation ?? 'validates'] * (edge.selfCitation ? 0.7 : 1) * recency
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), { target: edge.target, weight }])
  }
  let rank = { ...p }
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const next = Object.fromEntries(nodes.map((node) => [node, (1 - damping) * p[node]]))
    for (const source of nodes) {
      const edges = outgoing.get(source) ?? []
      const sum = edges.reduce((total, edge) => total + edge.weight, 0)
      if (!sum) {
        for (const target of nodes) next[target] += damping * rank[source] * p[target]
      } else {
        for (const edge of edges) next[edge.target] += damping * rank[source] * edge.weight / sum
      }
    }
    const delta = nodes.reduce((sum, node) => sum + Math.abs(next[node] - rank[node]), 0)
    rank = next
    if (delta < tolerance) break
  }
  const total = Object.values(rank).reduce((sum, value) => sum + value, 0)
  return Object.fromEntries(nodes.map((node) => [node, rank[node] / total]))
}
