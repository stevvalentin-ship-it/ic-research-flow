export const IC_DOMAINS = [
  '半导体器件与制造工艺',
  '模拟、射频与混合信号电路',
  '数字电路、处理器与 SoC 架构',
  '存储器与存算一体',
  'EDA、验证与设计方法',
  '电源管理与功率集成电路',
  '测试、可靠性与硬件安全',
  'Chiplet、先进封装与三维集成',
  '光子、神经形态等新型集成技术',
] as const

export type IcDomain = (typeof IC_DOMAINS)[number]
export type AnalysisStatus = 'queued' | 'parsing' | 'analyzing' | 'indexing' | 'completed' | 'failed' | 'paused'
export type CitationRelation = 'foundation' | 'extends' | 'validates' | 'contradicts' | 'background'
export type PaperRole = 'foundation' | 'hub' | 'frontier'

export interface DomainTag {
  domain: IcDomain
  confidence: number
  evidencePage?: number
  reason: string
}

export interface Evidence {
  page: number
  quote: string
  label: string
}

export interface PaperReference {
  title: string
  authors: string[]
  year?: number
  doi?: string
  relation: CitationRelation
  evidencePage?: number
  matchedPaperId?: string
  confidence?: number
}

export interface PaperFacets {
  objects: string[]
  problems: string[]
  methods: string[]
  processNodes: string[]
  metrics: string[]
  applications: string[]
  findings: string[]
  limitations: string[]
}

export interface PaperRecord {
  id: string
  fileName: string
  fileSize: number
  blob: Blob
  pageCount: number
  createdAt: number
  updatedAt: number
  title: string
  authors: string[]
  year?: number
  doi?: string
  venue?: string
  abstract?: string
  fullText: string
  pageTexts: string[]
  analysisStatus: AnalysisStatus
  analysisVersion: number
}

export interface PaperAnalysis {
  paperId: string
  domains: DomainTag[]
  facets: PaperFacets
  keywordsZh: string[]
  keywordsEn: string[]
  references: PaperReference[]
  summary: string
  evidence: Evidence[]
  analyzedAt: number
}

export interface ProcessingJob {
  id: string
  paperId: string
  stage: AnalysisStatus
  progress: number
  attempts: number
  errorCode?: string
  errorMessage?: string
  updatedAt: number
}

export interface QueryCacheRecord {
  key: string
  value: unknown
  updatedAt: number
}

export interface ApiSettings {
  baseUrl: string
  model: string
  apiKey: string
}

export interface StoredApiSettings extends ApiSettings {
  persistKey: boolean
}

export interface PaperScore {
  paperId: string
  relevance: number
  influence: number
  frontier: number
  evidence: number
  bridge: number
  total: number
  role: PaperRole
  reason: string
}

export interface ResearchResult {
  query: string
  candidateIds: string[]
  corePaperIds: string[]
  scores: PaperScore[]
  createdAt: number
}
