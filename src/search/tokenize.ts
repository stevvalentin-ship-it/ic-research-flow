import { IC_SYNONYMS } from './icTaxonomy'

const tokenPattern = /[a-z0-9]+(?:[.-][a-z0-9]+)*|[\u3400-\u9fff]+/gi

export function tokenizeIcText(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[／]/g, '/').replace(/[－–—]/g, '-')
  const raw = normalized.match(tokenPattern) ?? []
  const output = new Set<string>()
  for (const token of raw) {
    output.add(IC_SYNONYMS[token] ?? token)
    if (/^[\u3400-\u9fff]+$/.test(token) && token.length > 2) {
      for (let i = 0; i < token.length - 1; i += 1) output.add(token.slice(i, i + 2))
    }
  }
  return [...output]
}
