import { buildAnalysisPacket } from './analysisPacket'
import type { ParsedPdf } from './pdfParser'

describe('buildAnalysisPacket', () => {
  it('keeps the opening, methods, conclusion and references within the character budget', () => {
    const parsed: ParsedPdf = {
      title: 'Thermal-aware chiplet placement',
      pageCount: 5,
      pageTexts: [
        'ABSTRACT\n' + 'overview '.repeat(120),
        'METHOD\n' + 'optimization '.repeat(180),
        'EXPERIMENT\n' + 'measurement '.repeat(180),
        'CONCLUSION\n' + 'result '.repeat(120),
        'REFERENCES\n[1] Foundational TSV paper. ' + 'citation '.repeat(120),
      ],
      fullText: '',
    }
    parsed.fullText = parsed.pageTexts.join('\n')

    const packet = buildAnalysisPacket(parsed, 2_400)

    expect(packet.length).toBeLessThanOrEqual(2_400)
    expect(packet).toContain('PAGE 1')
    expect(packet).toContain('REFERENCES')
  })
})
