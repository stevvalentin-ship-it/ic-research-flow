import type { PaperAnalysis, PaperRecord } from '../../domain/types'
import { IC_DOMAINS } from '../../domain/types'

const DOMAIN_RULES: Array<[string, RegExp]> = [
  ['Chiplet、先进封装与三维集成', /chiplet|die-to-die|ucie|2\.5d|advanced packaging|silicon interposer|3d integration|through-silicon|tsv|先进封装|芯粒|三维集成/],
  ['数字电路、处理器与 SoC 架构', /risc-v|processor|soc|accelerator|cpu|core architecture|digital circuit|数字电路|处理器|加速器|架构/],
  ['存储器与存算一体', /memory|dram|sram|hbm|compute-in-memory|near-memory|存储|存算|内存/],
  ['EDA、验证与设计方法', /eda|synthesis|placement|routing|verification|formal verification|design space|design method|综合|布局|布线|验证/],
  ['半导体器件与制造工艺', /mosfet|cmos|finfet|transistor|semiconductor|device|manufactur|process node|器件|制造|工艺/],
  ['模拟、射频与混合信号电路', /analog|rf|mixed-signal|amplifier|adc|dac|模拟|射频|混合信号/],
  ['电源管理与功率集成电路', /power delivery|power integrity|voltage regulator|pmic|power management|电源|功率/],
  ['测试、可靠性与硬件安全', /reliab|hardware security|trojan|testing|testability|fault|可靠|安全|测试|硬件安全/],
  ['光子、神经形态等新型集成技术', /photonic|neuromorphic|optical interconnect|光子|神经形态|光互连/],
]

function inferDomain(paper: PaperRecord, analysis: PaperAnalysis | undefined): string {
  const explicit = analysis?.domains[0]?.domain
  if (explicit) return explicit
  const text = [
    paper.title,
    paper.fullText,
    paper.abstract ?? '',
    ...(analysis?.keywordsZh ?? []),
    ...(analysis?.keywordsEn ?? []),
  ].join(' ').toLowerCase()
  const domain = DOMAIN_RULES.find(([, pattern]) => pattern.test(text))?.[0]
  return domain ?? '未分类'
}

export function KnowledgeTree({ papers, analyses, onSelect }: { papers: PaperRecord[]; analyses: PaperAnalysis[]; onSelect: (id: string) => void }) {
  const byPaper = new Map(analyses.map((analysis) => [analysis.paperId, analysis]))
  const classified = papers.map((paper) => ({ paper, domain: inferDomain(paper, byPaper.get(paper.id)) }))
  const orderedDomains = [...IC_DOMAINS.filter((domain) => classified.some((item) => item.domain === domain))]
  const hasUnclassified = classified.some((item) => item.domain === '未分类')
  const domains = hasUnclassified ? [...orderedDomains, '未分类'] : orderedDomains
  return <div className="knowledge-tree"><div className="tree-root"><strong>当前科研问题</strong><small>CONTENT MAP</small></div><div className="tree-domains">{domains.map((domain) => <section key={domain}><h4>{domain}</h4>{classified.filter((item) => item.domain === domain).map(({ paper }) => <button key={paper.id} onClick={() => onSelect(paper.id)}><i />{paper.title}</button>)}</section>)}</div></div>
}
