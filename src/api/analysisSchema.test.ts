import { extractJsonObject, normalizePaperAnalysis } from './analysisSchema'

describe('analysisSchema', () => {
  it.each([
    ['{"summary":"ok"}', 'ok'],
    ['```json\n{"summary":"fenced"}\n```', 'fenced'],
    ['分析如下：\n{"summary":"prefixed"}', 'prefixed'],
  ])('extracts structured JSON from model text', (raw, summary) => {
    expect(extractJsonObject(raw).summary).toBe(summary)
  })

  it('keeps valid IC domains at or above the confidence threshold', () => {
    const analysis = normalizePaperAnalysis('paper-1', {
      summary: 'test',
      domains: [
        { domain: 'Chiplet、先进封装与三维集成', confidence: 0.91, reason: 'focus' },
        { domain: '模拟、射频与混合信号电路', confidence: 0.4, reason: 'weak' },
        { domain: '普通人工智能', confidence: 0.99, reason: 'invalid' },
      ],
    })

    expect(analysis.domains).toHaveLength(1)
    expect(analysis.domains[0].domain).toBe('Chiplet、先进封装与三维集成')
  })
})
