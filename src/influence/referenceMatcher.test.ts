import type { PaperAnalysis, PaperRecord } from '../domain/types'
import { matchLocalReferences } from './referenceMatcher'

const paper = (id: string, title: string, doi?: string): PaperRecord => ({
  id, title, doi, fileName: `${id}.pdf`, fileSize: 1, blob: new Blob(), pageCount: 1,
  createdAt: 0, updatedAt: 0, authors: [], fullText: '', pageTexts: [],
  analysisStatus: 'completed', analysisVersion: 1,
})

describe('matchLocalReferences', () => {
  it('matches DOI references to papers in the local library', () => {
    const analyses = [{ paperId: 'a', references: [{ title: 'other', authors: [], doi: '10.1/X', relation: 'extends' }], domains: [], facets: { objects: [], problems: [], methods: [], processNodes: [], metrics: [], applications: [], findings: [], limitations: [] }, keywordsZh: [], keywordsEn: [], summary: '', evidence: [], analyzedAt: 0 }] as PaperAnalysis[]
    const matched = matchLocalReferences([paper('a', 'A'), paper('b', 'B', '10.1/x')], analyses)
    expect(matched[0].references[0].matchedPaperId).toBe('b')
  })
  it('fuzzy matches reference titles when DOI is absent', () => {
    const analyses = [{ paperId: 'a', references: [{ title: 'Scalable Accelerator Architecture for Zero Knowledge Proofs', authors: [], relation: 'extends' }], domains: [], facets: { objects: [], problems: [], methods: [], processNodes: [], metrics: [], applications: [], findings: [], limitations: [] }, keywordsZh: [], keywordsEn: [], summary: '', evidence: [], analyzedAt: 0 }] as PaperAnalysis[]
    const matched = matchLocalReferences([paper('a', 'A'), paper('b', 'SZKP: A Scalable Accelerator Architecture for Zero-Knowledge Proofs')], analyses)
    expect(matched[0].references[0].matchedPaperId).toBe('b')
  })
})
