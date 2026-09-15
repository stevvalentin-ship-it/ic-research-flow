// ============================================================================
// Paper Parallel 核心数据模型(v1.0 冻结版,与实施计划第 4 节一致)
// 所有模块只通过 DocumentModel / AlignmentTable / Job 三种接口通信。
// ============================================================================

/** PDF 视口矩形(scale=1 时的 CSS 像素坐标) */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 单页信息 */
export interface PageInfo {
  pageIndex: number;
  width: number;
  height: number;
  /** 该页检测出的栏(混合版式的关键) */
  columns: ColumnInfo[];
}

/** 一栏的坐标范围 */
export interface ColumnInfo {
  pageIndex: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  /** full = 通栏(标题/摘要区),left/right = 双栏正文 */
  kind: 'full' | 'left' | 'right';
}

export type BlockType =
  | 'title'
  | 'authors'
  | 'abstract'
  | 'keywords'
  | 'section'
  | 'paragraph'
  | 'figure'
  | 'table'
  | 'equation'
  | 'caption'
  | 'reference'
  | 'other';

/** 宽度属性:继承原论文(单栏宽 / 跨双栏宽) */
export type WidthMode = 'column' | 'span';

/** 块的单个排版片段(跨页/跨栏续接的段落有多个) */
export interface BlockFragment {
  pageIndex: number;
  rect: Rect;
}

/** PDF.js 文字在原块文本中的索引与真实页面坐标。 */
export interface CharacterRect {
  ch: string;
  sourceIndex: number;
  pageIndex: number;
  rect: Rect;
}

/** 块 —— 整个系统的原子单位 */
export interface Block {
  id: string; // 全项目唯一,如 'en-b42'
  docId: 'en' | 'zh';
  type: BlockType;
  pageIndex: number;
  rect: Rect;
  /** 全局块序号,块级保序(R5)的唯一依据 */
  order: number;
  prevBlockId?: string;
  nextBlockId?: string;
  /** 跨页/跨栏续接的段落片段;单页块为长度 1 的数组 */
  fragments?: BlockFragment[];
  text?: string;
  /** 裁剪 PNG 的存储键(Dexie 中) */
  imageRef?: string;
  /** 表格结构(提取成功时);失败则降级为整表图 */
  tableJson?: TableJson;
  parentSectionId?: string;
  /** 排版时是否可跨栏/跨页截断(图/表/公式/图注=false) */
  splitAllowed: boolean;
  widthMode: WidthMode;
  /** 人工审核标记:降级处理 */
  zipped?: boolean;
  /** 字符级坐标映射:文本下标 -> PDF 视口矩形(词级高亮用) */
  charRects?: Rect[];
  /** 新对齐管线使用的跨页字符索引。 */
  characterRects?: CharacterRect[];
}

export interface TableJson {
  rows: number;
  cols: number;
  cells: { row: number; col: number; rowSpan: number; colSpan: number; text: string }[];
}

/** 版式模式(单栏 / 双栏 / 混合) */
export type LayoutMode = 'single' | 'double' | 'mixed';

export interface LayoutRegion {
  id: string;
  mode: 'single' | 'double' | 'full-width';
  sourcePage: number;
  bounds: Rect;
  columnGap?: number;
  presentation?: 'horizontal';
  orderedUnitIds: string[];
}

export type SemanticUnitKind =
  | 'title' | 'author' | 'affiliation' | 'abstract' | 'keywords' | 'heading'
  | 'paragraph' | 'sentence' | 'list-item' | 'caption' | 'table-title'
  | 'figure' | 'table' | 'formula' | 'code' | 'reference' | 'page-furniture';

export interface SemanticUnit {
  id: string;
  parentId?: string;
  /** 原始英文 PDF 中承载该单元文字与字符坐标的块 ID。 */
  sourceBlockId?: string;
  /** 重建跨栏/跨块语义时共同承载源文字的块 ID。 */
  sourceBlockIds?: string[];
  kind: SemanticUnitKind;
  /** 标题层级和编号必须从英文源文档确定，不能根据译文反推。 */
  headingLevel?: 1 | 2 | 3;
  headingNumber?: string;
  sourceText?: string;
  translation?: string;
  protectedTokens: string[];
  sourceSentenceIds?: string[];
  assetId?: string;
  crossPageAssetGroupId?: string;
  layoutRegionId: string;
  order: number;
}

/** 统一文档模型:英文侧与中文侧是同一类型的两个实例 */
export interface Doc {
  id: string;
  role: 'en' | 'zh';
  pageCount: number;
  pages: PageInfo[];
  blocks: Block[];
  layoutRegions: LayoutRegion[];
  semanticUnits: SemanticUnit[];
  layoutMode: LayoutMode;
  meta: { paperWidth: number; paperHeight: number; title?: string };
}

/** 对齐颗粒度(降级信息,R15) */
export type AlignmentLevel = 'sentence' | 'paragraph' | 'section';

/** 词级对应 span(LLM 直出 + 子串校验) */
export interface WordSpan {
  zhText: string;
  enText: string;
  enBlockId: string;
  enCharRange: [number, number];
  validated: boolean;
}

/** 一个语义单元在某份 PDF 中的一组可视矩形。 */
export interface AlignmentRectSet {
  page: number;
  rects: Rect[];
}

export type AlignmentRelation =
  | '1:1'
  | '1:n'
  | 'n:1'
  | 'n:m'
  | 'paragraph-fallback'
  | 'block'
  | 'asset'
  | 'reference';

/** 对齐单元 —— 同步滚动/语义组高亮/审核的唯一数据源。 */
export interface AlignmentUnit {
  id: string;
  parentId?: string;
  /** 原始英文 PDF 中承载该对齐单元的块 ID。 */
  sourceBlockId?: string;
  /** 对齐单元由多个英文源块共同重建时的完整块集合。 */
  sourceBlockIds?: string[];
  kind: 'semantic-group' | 'block' | 'asset' | 'reference';
  relation: AlignmentRelation;
  sourceUnitIds: string[];
  targetUnitIds: string[];
  sourceText?: string;
  targetText?: string;
  source: AlignmentRectSet[];
  target: AlignmentRectSet[];
  confidence: number;
  status: 'aligned' | 'low-confidence' | 'unmatched';
  fallbackReason?: string;
  order?: number;
  spans?: WordSpan[];
}

/** 仅供旧对齐核心迁移期使用；新阅读器不再消费该结构。 */
export interface LegacyAlignmentUnit {
  id: string;
  enBlockIds: string[];
  zhBlockIds: string[];
  level: AlignmentLevel;
  confidence: number;
  status: 'aligned' | 'needs-review' | 'fallback';
  spans?: WordSpan[];
}

export interface AlignmentTable {
  projectId: string;
  source: 'pipeline-a' | 'engine-b' | 'imported';
  units: Array<AlignmentUnit | LegacyAlignmentUnit>;
}

/** 术语条目(R14:从译文首次出现格式自动抽取) */
export interface TermEntry {
  zh: string;
  en: string;
  abbr?: string;
  firstBlockId: string;
}

/** 翻译任务状态 */
export type JobState = 'idle' | 'running' | 'paused' | 'done' | 'failed';

export interface JobBlock {
  blockId: string;
  kind: Exclude<BlockType, 'figure' | 'table' | 'equation'>;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
}

export interface TranslationJob {
  projectId: string;
  pass: 1 | 2; // 1=章级粗译取术语;2=块级精译
  blocks: JobBlock[];
  completed: number;
  failed: number;
  state: JobState;
  tokenUsage: { promptTokens: number; completionTokens: number };
}

/** 审核三关 */
export interface AuditIssue {
  id: string;
  kind: 'rule' | 'ai' | 'manual';
  severity: 'error' | 'warn';
  blockId?: string;
  enBlockId?: string;
  zhBlockId?: string;
  message: string;
  resolved: boolean;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  mode: 'A' | 'B';
  enPdfKey?: string;
  zhPdfKey?: string;
  stage:
    | 'enParsed'
    | 'translated'
    | 'laidOut'
    | 'aligned'
    | 'auditing'
    | 'approved';
}

/** 端到端处理任务的显式阶段。 */
export type TaskStage =
  | 'idle'
  | 'parsing'
  | 'analyzing-layout'
  | 'building-glossary'
  | 'translating'
  | 'composing'
  | 'compiling'
  | 'aligning'
  | 'validating'
  | 'completed';

export type TaskStatus = 'idle' | 'running' | 'pausing' | 'paused' | 'stopping' | 'stopped' | 'failed' | 'completed';

export type RecoverablePauseReason =
  | 'network-retries-exhausted'
  | 'render-retries-exhausted'
  | 'vision-protocol-retries-exhausted'
  | 'source-layout-unresolved'
  | 'vision-correction-budget-exhausted';

/** Persisted, user-facing state for source-layout analysis and bounded correction. */
export interface VisionAttemptState {
  phase:
    | 'initial-analysis'
    | 'local-validation'
    | 'correction-full-page'
    | 'correction-local-crop'
    | 'structure-generation'
    | 'structure-validation'
    | 'final-review';
  pageIndex?: number;
  totalPages: number;
  correctionRound: 0 | 1 | 2;
  remainingPageRounds: number;
  validatedPages: number;
  failedPages: number[];
  cachedPages: number;
  correctionCallsUsed: number;
  maxCorrectionCalls: number;
  promptTokens: number;
  completionTokens: number;
  regionType?: 'figure' | 'table' | 'display_formula' | 'code' | 'page';
  repairAction?: 'adjust-geometry' | 'adjust-caption' | 'adjust-reading-order' | 'add-or-remove-region';
  roundPromptTokens?: number;
  roundCompletionTokens?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface TaskProgress {
  completed: number;
  total: number;
  retries: number;
  failed: number;
}

export interface TaskSnapshot {
  projectId: string;
  stage: TaskStage;
  status: TaskStatus;
  progress: TaskProgress;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  error?: string;
  pauseReason?: RecoverablePauseReason;
  visionAttempt?: VisionAttemptState;
  settings?: {
    /** User-selected model for natural-language translation only. */
    modelId: string;
    /** Fixed formal visual-analysis/review model, persisted for reproducibility. */
    visionModelId?: string;
    thinkingMode: 'enabled' | 'disabled';
    qualityPolicy?: 'readable-first' | 'strict';
    sourceFileName: string;
    sourceFileHash: string;
    /** 新任务固定为中文单栏；source-layout 只用于识别历史任务。 */
    targetLayoutPolicy?: 'single-column' | 'source-layout';
    layoutProfileVersion?: string;
    /** Persisted so resumed runs cannot silently receive a larger correction budget. */
    maxVisionCorrectionCalls?: number;
  };
}
