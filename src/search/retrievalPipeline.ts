import { IC_QUERY_EXPANSIONS } from './icTaxonomy'
import type { LocalPaperIndex, LocalSearchResult } from './localSearch'
import { tokenizeIcText } from './tokenize'

export interface QueryExpansion {
  terms: string[]
}

export async function retrieveCandidates(
  index: LocalPaperIndex,
  query: string,
  expand?: (query: string) => Promise<QueryExpansion>,
  limit = 50,
): Promise<LocalSearchResult[]> {
  const localTerms = tokenizeIcText(query).flatMap((term) => [term, ...(IC_QUERY_EXPANSIONS[term] ?? [])])
  let aiTerms: string[] = []
  if (expand) {
    try { aiTerms = (await expand(query)).terms }
    catch { aiTerms = [] }
  }
  const expandedQuery = [...new Set([query, ...localTerms, ...aiTerms])].join(' ')
  return index.search(expandedQuery, Math.min(50, limit))
}
