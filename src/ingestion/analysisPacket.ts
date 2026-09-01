import type { ParsedPdf } from './pdfParser'

function pageBlock(text: string, page: number, limit: number): string {
  return `--- PAGE ${page} ---\n${text.slice(0, Math.max(0, limit - 20))}`
}

export function buildAnalysisPacket(parsed: ParsedPdf, maxCharacters = 48_000): string {
  if (!parsed.pageTexts.length) return ''
  const selected = new Map<number, number>()
  const lastIndex = parsed.pageTexts.length - 1
  selected.set(0, Math.floor(maxCharacters * 0.3))
  if (lastIndex > 0) selected.set(lastIndex, Math.floor(maxCharacters * 0.3))

  const middle = Array.from({ length: Math.max(0, lastIndex - 1) }, (_, index) => index + 1)
  const remaining = maxCharacters - Array.from(selected.values()).reduce((sum, value) => sum + value, 0)
  const perMiddle = middle.length ? Math.max(180, Math.floor(remaining / middle.length)) : 0
  middle.forEach((index) => selected.set(index, perMiddle))

  const blocks = Array.from(selected.entries())
    .sort(([a], [b]) => a - b)
    .map(([index, limit]) => pageBlock(parsed.pageTexts[index], index + 1, limit))
  return blocks.join('\n\n').slice(0, maxCharacters)
}
