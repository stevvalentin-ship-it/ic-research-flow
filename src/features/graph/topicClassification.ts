import type { PaperAnalysis, PaperRecord } from '../../domain/types'

export interface TopicRule {
  label: string
  patterns: RegExp
}

const GENERIC_TERMS = new Set([
  'accelerator', 'architecture', 'design', 'analysis', 'system',
  'scalable', 'efficient', 'optimization', 'high', 'low', 'multi',
  'using', 'based', 'toward', 'approach', 'method', 'paper', 'implementation',
  '加速', '架构', '设计', '研究', '高效', '优化', '方法', '实现',
])

export const DYNAMIC_TOPIC_RULES: TopicRule[] = [
  { label: 'GPU / AI 加速器', patterns: /gpu|ai accelerator|accelerator|zero-?knowledge|zkp|tensor|parallel computing|cuda|warp|proof/i },
  { label: 'CPU / RISC-V 处理器', patterns: /risc-?v|processor|cpu|core architecture|instruction set|scalar|processor architecture/i },
  { label: 'Chiplet / 先进封装', patterns: /chiplet|die-to-die|ucie|2\.5d|advanced packaging|interposer|tsv|silicon bridge|advanced package/i },
  { label: '存储器 / 存算一体', patterns: /memory|dram|sram|hbm|compute-in-memory|near-memory|storage|memory hierarchy/i },
  { label: 'FPGA / 可重构计算', patterns: /fpga|reconfigur|lookup table|logic block|field-programmable/i },
  { label: '互连 / 片上网络', patterns: /interconnect|network-on-chip|noc|mesh|pcie|serial link|die-to-die|bus/i },
  { label: 'EDA / 设计与验证', patterns: /eda|synthesis|placement|routing|verification|formal verification|design space|physical design/i },
  { label: '热 / 电源管理', patterns: /thermal|power delivery|power integrity|temperature|cooling|voltage regulator|power management|therm/i },
  { label: '安全 / 可靠性', patterns: /security|trojan|reliab|fault|attack|side-channel|hardware security/i },
]

function paperText(paper: PaperRecord, analysis: PaperAnalysis | undefined): string {
  return [
    paper.title,
    paper.abstract ?? '',
    paper.fullText,
    ...(analysis?.keywordsZh ?? []),
    ...(analysis?.keywordsEn ?? []),
    ...(analysis?.facets.objects ?? []),
    ...(analysis?.facets.methods ?? []),
    ...(analysis?.facets.metrics ?? []),
    ...(analysis?.facets.applications ?? []),
  ].join(' ')
}

function meaningfulFocusCandidates(paper: PaperRecord, analysis: PaperAnalysis | undefined): string[] {
  const candidates = [
    ...(analysis?.keywordsEn ?? []),
    ...(analysis?.keywordsZh ?? []),
    ...(analysis?.facets.objects ?? []),
    ...(analysis?.facets.methods ?? []),
    ...(analysis?.facets.metrics ?? []),
    ...(analysis?.facets.applications ?? []),
    paper.title,
  ]
  const seen = new Set<string>()
  const result: string[] = []
  for (const candidate of candidates) {
    const normalized = candidate.trim()
    if (!normalized) continue
    const lower = normalized.toLowerCase()
    if (GENERIC_TERMS.has(lower)) continue
    if (seen.has(lower)) continue
    seen.add(lower)
    result.push(normalized)
    if (result.length >= 3) break
  }
  return result
}

export function classifyPaperTopic(paper: PaperRecord, analysis: PaperAnalysis | undefined): string {
  const text = paperText(paper, analysis)
  const broad = DYNAMIC_TOPIC_RULES.find((item) => item.patterns.test(text))?.label ?? '其他'
  const focuses = meaningfulFocusCandidates(paper, analysis)
  if (focuses.length) return `${broad} · ${focuses[0]}`
  return broad
}

export function findSecondaryFocus(paper: PaperRecord, analysis: PaperAnalysis | undefined, used: Set<string>): string {
  const focuses = meaningfulFocusCandidates(paper, analysis)
  const found = focuses.find((focus) => !used.has(focus))
  if (found) return found
  const fallback = paper.title.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).slice(0, 3).join(' ') || paper.id
  return fallback
}
