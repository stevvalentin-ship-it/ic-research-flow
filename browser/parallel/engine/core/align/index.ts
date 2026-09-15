// ============================================================================
// align/index.ts —— 对齐引擎类型化入口(核心在 align.core.js,不复制逻辑)
// ============================================================================
import './align.core.js';
import './alignBlocks.core.js';

export interface SentenceAlignUnit {
  enIndices: number[];
  zhIndices: number[];
  confidence: number;
  fallback?: boolean;
  spans?: ValidatedSpan[];
}

export interface ValidatedSpan {
  en: string;
  zh: string;
  validated: boolean;
  enIndices?: number[];
  zhIndices?: number[];
}

export interface BlockPairAlignResult {
  level: 'sentence' | 'paragraph';
  enBlockId: string;
  zhBlockId: string;
  enSentences: string[];
  zhSentences: string[];
  confidence: number;
  units: SentenceAlignUnit[];
  spans: ValidatedSpan[];
}

export type SentenceScoreFn = (enIdx: number, zhIdx: number) => Promise<number> | number;

interface Core {
  splitSentences(text: string): string[];
  normalize(s: string): string;
  validateSpans(enText: string, zhText: string, spans: { en: string; zh: string }[]): ValidatedSpan[];
  alignSentenceSequences(
    en: string[],
    zh: string[],
    scoreFn: SentenceScoreFn,
    opts?: { unmatchedPenalty?: number; minConfidence?: number },
  ): Promise<{
    units: SentenceAlignUnit[];
    avgConfidence: number;
    matchedEn: number;
    matchedZh: number;
    minConfidence: number;
  }>;
  alignBlockPair(
    enBlock: { id: string; text: string },
    zhBlock: { id: string; text: string },
    opts: {
      scoreFn: SentenceScoreFn;
      spansForPair?: (pair: { enText: string; zhText: string; enIndices: number[]; zhIndices: number[] }) => Promise<{ en: string; zh: string }[]> | { en: string; zh: string }[];
      minConfidence?: number;
    },
  ): Promise<BlockPairAlignResult>;
}

const core = (globalThis as any).PaperParallelAlign as Core;

export const splitSentences = core.splitSentences.bind(core) as Core['splitSentences'];
export const normalize = core.normalize.bind(core) as Core['normalize'];
export const validateSpans = core.validateSpans.bind(core) as Core['validateSpans'];
export const alignSentenceSequences = core.alignSentenceSequences.bind(core) as Core['alignSentenceSequences'];
export const alignBlockPair = core.alignBlockPair.bind(core) as Core['alignBlockPair'];

export interface AlignBlock {
  id: string;
  type: string;
  text?: string;
  order: number;
}

export interface Anchor {
  label: string;
  kind: 'section' | 'caption';
  blockId: string;
  order: number;
  text: string;
}

export interface AnchorPair {
  label: string;
  enBlockId: string;
  zhBlockId: string;
  source: 'auto' | 'manual';
  enOrder?: number;
  zhOrder?: number;
}

export interface BlockAlignUnit {
  enBlockIds: string[];
  zhBlockIds: string[];
  confidence: number;
  level: 'paragraph' | 'section';
  anchor?: string;
  anchorSource?: 'auto' | 'manual';
}

export interface AnchorAlignmentResult {
  units: BlockAlignUnit[];
  anchors: AnchorPair[];
  unmatchedAnchors: { en: Anchor[]; zh: Anchor[] };
  calibrationIssues: string[];
  avgConfidence: number;
  degraded: boolean;
}

interface BlocksCore {
  normalizeAnchorLabel(type: string, text: string): string | null;
  extractAnchors(blocks: AlignBlock[]): Anchor[];
  matchAnchors(enAnchors: Anchor[], zhAnchors: Anchor[]): { pairs: AnchorPair[]; unmatchedEn: Anchor[]; unmatchedZh: Anchor[] };
  applyManualAnchorOverrides(
    pairs: AnchorPair[],
    overrides: { label: string; enBlockId?: string; zhBlockId?: string | null }[],
  ): { pairs: AnchorPair[]; issues: string[] };
  alignBlockRange(
    en: AlignBlock[],
    zh: AlignBlock[],
    scoreFn: (enBlock: AlignBlock, zhBlock: AlignBlock) => Promise<number> | number,
    opts?: { unmatchedPenalty?: number },
  ): Promise<{ units: { enIndices: number[]; zhIndices: number[]; confidence: number }[]; avgConfidence: number }>;
  alignBlocksWithAnchors(
    enBlocks: AlignBlock[],
    zhBlocks: AlignBlock[],
    opts: {
      scoreFn: (enBlock: AlignBlock, zhBlock: AlignBlock) => Promise<number> | number;
      manualOverrides?: { label: string; enBlockId?: string; zhBlockId?: string | null }[];
      minConfidence?: number;
    },
  ): Promise<AnchorAlignmentResult>;
}

const blocksCore = (globalThis as any).PaperParallelAlignBlocks as BlocksCore;

export const normalizeAnchorLabel = blocksCore.normalizeAnchorLabel.bind(blocksCore) as BlocksCore['normalizeAnchorLabel'];
export const extractAnchors = blocksCore.extractAnchors.bind(blocksCore) as BlocksCore['extractAnchors'];
export const matchAnchors = blocksCore.matchAnchors.bind(blocksCore) as BlocksCore['matchAnchors'];
export const applyManualAnchorOverrides = blocksCore.applyManualAnchorOverrides.bind(blocksCore) as BlocksCore['applyManualAnchorOverrides'];
export const alignBlockRange = blocksCore.alignBlockRange.bind(blocksCore) as BlocksCore['alignBlockRange'];
export const alignBlocksWithAnchors = blocksCore.alignBlocksWithAnchors.bind(blocksCore) as BlocksCore['alignBlocksWithAnchors'];

export {
  buildBlockAndAssetAlignmentUnits,
  buildSemanticGroups,
} from './semanticUnits';
export type {
  OrderedSemanticInput,
  SourceCandidateBlock,
} from './semanticUnits';
export { resolveSourceGeometry, resolveTextRangeRects } from './sourceGeometry';
export { readTargetMarkers } from './targetMarkers';
export { matchTranslatedText } from './textFallback';
export type { TargetTextMatch, TargetTextSegment } from './textFallback';
export { buildAlignmentManifest } from './manifest';
export type { AlignmentManifest, AlignmentManifestInput } from './manifest';
