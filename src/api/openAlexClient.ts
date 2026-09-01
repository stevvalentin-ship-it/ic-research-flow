export interface OpenAlexWork {
  id: string
  title: string
  publication_year?: number
  cited_by_count: number
  counts_by_year: Array<{ year: number; cited_by_count: number }>
}

const cache = new Map<string, OpenAlexWork | undefined>()

export async function fetchOpenAlexByDoi(doi: string, fetchImpl: typeof fetch = fetch): Promise<OpenAlexWork | undefined> {
  const normalized = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase()
  if (cache.has(normalized)) return cache.get(normalized)
  try {
    const url = new URL(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(normalized)}`)
    url.searchParams.set('select', 'id,title,publication_year,cited_by_count,counts_by_year')
    const response = await fetchImpl(url)
    if (!response.ok) return undefined
    const work = await response.json() as OpenAlexWork
    cache.set(normalized, work)
    return work
  } catch {
    cache.set(normalized, undefined)
    return undefined
  }
}
