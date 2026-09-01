import MiniSearch, { type SearchResult as MiniSearchResult } from 'minisearch'
import type { PaperAnalysis, PaperRecord } from '../domain/types'
import { tokenizeIcText } from './tokenize'

interface SearchDocument {
  id: string
  title: string
  keywords: string
  abstract: string
  findings: string
  fullText: string
}

export interface LocalSearchResult {
  id: string
  score: number
  terms: string[]
}

export class LocalPaperIndex {
  private readonly index: MiniSearch<SearchDocument>

  constructor(papers: PaperRecord[], analyses: PaperAnalysis[] = []) {
    const analysisByPaper = new Map(analyses.map((item) => [item.paperId, item]))
    this.index = new MiniSearch<SearchDocument>({
      idField: 'id',
      fields: ['title', 'keywords', 'abstract', 'findings', 'fullText'],
      tokenize: tokenizeIcText,
      storeFields: ['id'],
      searchOptions: {
        boost: { title: 5, keywords: 4, abstract: 3, findings: 2, fullText: 1 },
        prefix: true,
        fuzzy: 0.16,
      },
    })
    this.index.addAll(papers.map((paper) => {
      const analysis = analysisByPaper.get(paper.id)
      return {
        id: paper.id,
        title: paper.title,
        keywords: [...(analysis?.keywordsZh ?? []), ...(analysis?.keywordsEn ?? [])].join(' '),
        abstract: paper.abstract ?? '',
        findings: analysis?.facets.findings.join(' ') ?? '',
        fullText: paper.fullText,
      }
    }))
  }

  search(query: string, limit = 50): LocalSearchResult[] {
    return this.index.search(query).slice(0, Math.min(50, Math.max(1, limit))).map((result: MiniSearchResult) => ({
      id: String(result.id),
      score: result.score,
      terms: result.terms,
    }))
  }
}
