import type { PaperAnalysis, PaperRecord, PaperScore } from '../../domain/types'
import { buildInfluenceGraph } from './graphModel'

const records = ['a', 'b', 'c'].map((id, index) => ({ id, title: id.toUpperCase(), year: 2022 + index })) as PaperRecord[]
const analyses = [{ paperId: 'a', references: [{ title: 'B', authors: [], matchedPaperId: 'b', relation: 'extends' }] }] as unknown as PaperAnalysis[]
const scores = [
  { paperId: 'a', role: 'frontier', total: 0.9 },
  { paperId: 'b', role: 'hub', total: 0.8 },
  { paperId: 'c', role: 'foundation', total: 0.7 },
] as PaperScore[]

describe('buildInfluenceGraph', () => {
  it('creates unique role-labelled paper nodes and weighted edges', () => {
    const graph = buildInfluenceGraph(records, analyses, scores)
    expect(graph.nodes.map((node) => node.role)).toEqual(['frontier', 'hub', 'foundation'])
    expect(graph.edges[0]).toMatchObject({ source: 'a', target: 'b', weight: 1.1 })
  })
})
