import type { IcDomain, PaperAnalysis, PaperRecord, PaperScore } from '../../domain/types'

const titles = [
  'Thermal-Aware Chiplet Placement for 2.5D Systems',
  'UCIe-Based Die-to-Die Interconnect Architecture',
  'Co-Optimization of TSV Networks and Power Delivery',
  'A Survey of Heterogeneous Chiplet Integration',
  'Machine Learning for Advanced Node Physical Design',
  'Reliable 3D IC Design Under Thermal Variation',
  'High-Bandwidth Memory Interface for AI Accelerators',
  'Design Space Exploration of RISC-V Chiplet Systems',
  'Silicon Interposer Routing with Signal Integrity',
  'Runtime Thermal Management for Many-Core SoCs',
  'Near-Memory Computing with 3D Stacked DRAM',
  'Formal Verification of Die-to-Die Protocols',
  'Power Integrity Analysis for Advanced Packaging',
  'Secure Chiplet Integration Against Hardware Trojans',
  'Photonic Interconnects for Disaggregated Compute',
]

const domains: IcDomain[] = ['Chiplet、先进封装与三维集成', 'EDA、验证与设计方法', '数字电路、处理器与 SoC 架构', '存储器与存算一体', '测试、可靠性与硬件安全']

export const demoPapers: PaperRecord[] = titles.map((title, index) => ({
  id: `demo-${index + 1}`, fileName: `${title}.pdf`, fileSize: 2_000_000 + index * 12_000, blob: new Blob(), pageCount: 12 + index,
  createdAt: Date.now(), updatedAt: Date.now(), title, authors: [`Author ${String.fromCharCode(65 + index)}`], year: 2012 + index,
  venue: index % 2 ? 'IEEE TCAD' : 'DAC', abstract: `${title} focuses on integrated-circuit design methodology and quantitative evaluation.`,
  fullText: `${title} chiplet thermal TSV die-to-die advanced packaging EDA architecture`, pageTexts: [], analysisStatus: 'completed', analysisVersion: 1,
}))

export const demoAnalyses: PaperAnalysis[] = demoPapers.map((paper, index) => ({
  paperId: paper.id,
  domains: [{ domain: domains[index % domains.length], confidence: 0.9, reason: '核心技术对象与该知识域一致' }],
  facets: { objects: ['chiplet system'], problems: ['thermal and interconnect co-design'], methods: ['multi-objective optimization'], processNodes: ['7nm'], metrics: ['peak temperature', 'latency'], applications: ['AI accelerator'], findings: ['improves performance per watt'], limitations: ['requires larger benchmark set'] },
  keywordsZh: ['芯粒', '热管理', '先进封装'], keywordsEn: ['chiplet', 'thermal', 'TSV'],
  references: index === 0 ? [] : [
    { title: demoPapers[index - 1].title, authors: [], year: demoPapers[index - 1].year, relation: index % 4 === 0 ? 'foundation' : 'extends', matchedPaperId: demoPapers[index - 1].id, confidence: 0.96 },
    ...(index > 3 ? [{ title: demoPapers[Math.floor(index / 3)].title, authors: [], relation: 'background' as const, matchedPaperId: demoPapers[Math.floor(index / 3)].id, confidence: 0.9 }] : []),
  ],
  summary: `围绕${paper.title.includes('Thermal') ? '热约束' : '异构集成'}提出可复现的协同优化方法，并报告关键性能指标。`,
  evidence: [{ page: Math.min(7, paper.pageCount), label: '关键结论', quote: 'The proposed method improves the primary metric while satisfying design constraints.' }],
  analyzedAt: Date.now(),
}))

export const demoScores: PaperScore[] = demoPapers.map((paper, index) => {
  const relevance = 0.96 - index * 0.018
  const influence = 0.72 + (index % 5) * 0.045
  const frontier = Math.min(0.98, 0.42 + index * 0.04)
  const evidence = 0.86 - (index % 3) * 0.05
  const bridge = 0.45 + (index % 4) * 0.1
  const total = 0.4 * relevance + 0.3 * influence + 0.15 * frontier + 0.1 * evidence + 0.05 * bridge
  return { paperId: paper.id, relevance, influence, frontier, evidence, bridge, total, role: index < 3 ? 'foundation' : index > 10 ? 'frontier' : 'hub', reason: index > 10 ? '时间新颖度高，并连接多个集成电路技术分支。' : '与检索主题高度相关，在本地引用网络中承担关键连接作用。' }
})
