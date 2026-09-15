// ============================================================================
// translate/index.ts —— 翻译管线的类型化入口(核心编排在 pipeline.core.js,
// 浏览器/Node 同一份源码;本文件只做类型包装,不复制逻辑)
// ============================================================================
import './pipeline.core.js';
import './session.core.js';

export interface TranslateBlockInput {
  id: string;
  type: string;
  text: string;
  parentSectionId?: string;
  order: number;
}

export interface TermEntry {
  zh: string;
  en: string;
  abbr?: string;
}

export interface TranslateContext {
  pass: 1 | 2;
  block?: TranslateBlockInput;
  chapterTitle?: string;
  chapterText?: string;
  terms: TermEntry[];
  priorContext?: string;
  systemPrompt: string;
  userPrompt: string;
  attempt: number;
}

export interface PipelineBlockResult extends TranslateBlockInput {
  zhText: string;
  status: 'done' | 'failed';
  attempts: number;
  error?: string;
}

export interface PipelineStats {
  pass1Chapters: number;
  pass2Blocks: number;
  done: number;
  failed: number;
  retries: number;
}

export interface PipelineResult {
  blocks: PipelineBlockResult[];
  terms: TermEntry[];
  stats: PipelineStats;
  transcript: unknown[];
  assembled: string;
}

interface Core {
  extractTerms(text: string): TermEntry[];
  validateTranslation(text: string, source: string): { ok: boolean; reason?: string };
  mockTranslatePreservingStructure(ctx: TranslateContext): string;
  runTranslationPipeline(
    blocks: TranslateBlockInput[],
    opts: {
      translate: (ctx: TranslateContext) => Promise<string>;
      onProgress?: (evt: unknown) => void;
      shouldStop?: () => boolean;
      maxRetries?: number;
      systemPrompt?: string;
      userPrompt?: string;
    },
  ): Promise<PipelineResult>;
}

const core = (globalThis as any).PaperParallelPipeline as Core;

export const extractTerms = core.extractTerms.bind(core) as Core['extractTerms'];
export const validateTranslation = core.validateTranslation.bind(core) as Core['validateTranslation'];
export const mockTranslatePreservingStructure = core.mockTranslatePreservingStructure.bind(core) as Core['mockTranslatePreservingStructure'];
export const runTranslationPipeline = core.runTranslationPipeline.bind(core) as Core['runTranslationPipeline'];

export interface SessionState {
  byId: Record<string, { zhText?: string; status: 'done' | 'failed'; attempts?: number; error?: string }>;
  terms: TermEntry[];
}

export interface SessionBlockResult extends TranslateBlockInput {
  zhText: string;
  status: 'done' | 'failed';
  attempts: number;
  resumed?: boolean;
  error?: string;
}

interface SessionCore {
  buildSystemPrompt(system: { roleDefinition?: string; task?: string; wrapper?: string }): string;
  buildUserPrompt(opts: {
    pass: 1 | 2;
    userPrompt: string;
    chapterTitle?: string;
    chapterText?: string;
    terms?: TermEntry[];
    priorContext?: string;
    block?: TranslateBlockInput;
  }): string;
  buildSessionStorageKey(baseKey: string, engine: 'mock' | 'real', version: string): string;
  runResumableTranslation(
    blocks: TranslateBlockInput[],
    opts: {
      translate: (ctx: TranslateContext) => Promise<string>;
      loadState: () => Promise<SessionState> | SessionState;
      saveState: (state: SessionState) => Promise<void> | void;
      onProgress?: (evt: unknown) => void;
      maxRetries?: number;
      systemPrompt?: string;
      userPrompt?: string;
    },
  ): Promise<{
    blocks: SessionBlockResult[];
    terms: TermEntry[];
    stats: PipelineStats & { resumed: number };
    assembled: string;
  }>;
}

const session = (globalThis as any).PaperParallelTranslateSession as SessionCore;

export const buildSystemPrompt = session.buildSystemPrompt.bind(session) as SessionCore['buildSystemPrompt'];
export const buildUserPrompt = session.buildUserPrompt.bind(session) as SessionCore['buildUserPrompt'];
export const buildSessionStorageKey = session.buildSessionStorageKey.bind(session) as SessionCore['buildSessionStorageKey'];
/** @deprecated Probe-only compatibility path; application routes use runTranslationTask. */
export const runResumableTranslation = session.runResumableTranslation.bind(session) as SessionCore['runResumableTranslation'];

export * from './client';
export * from './events';
export * from './coordinator';
