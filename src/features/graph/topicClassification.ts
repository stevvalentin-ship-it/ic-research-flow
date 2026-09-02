import type { PaperAnalysis, PaperRecord } from '../../domain/types'

export interface TopicRule {
  label: string
  patterns: RegExp
}

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

export function classifyPaperTopic(paper: PaperRecord, analysis: PaperAnalysis | undefined): string {
  const rule = DYNAMIC_TOPIC_RULES.find((item) => item.patterns.test(paperText(paper, analysis)))
  if (rule) return rule.label
  const keyword = analysis?.keywordsEn[0] ?? analysis?.keywordsZh[0]
  if (keyword) return keyword
  return '其他'
}
