// ============================================================================
// reader/index.ts —— 对照阅读器核心类型化入口(核心在 reader.core.js)
// ============================================================================
import './reader.core.js';

export interface PositionedBlock {
  id: string;
  pageIndex: number;
  rect: { y: number; h: number };
}

export interface ReaderBlock extends PositionedBlock {
  type: string;
  text: string;
  matched?: boolean;
  unitIndex?: number | null;
  sourcePageIndex?: number | null;
  sourceRect?: Record<string, unknown> | null;
}

export interface ReaderSpan {
  en: string;
  zh: string;
  enBlockId: string;
  zhBlockId: string;
}

export interface ReaderProjectPackage {
  enDoc?: { blocks?: Array<Record<string, unknown>> };
  zhDoc?: { blocks?: Array<Record<string, unknown>> };
  units?: { enBlockIds: string[]; zhBlockIds: string[] }[];
  spans?: ReaderSpan[];
}

export interface ReaderModel {
  enBlocks: ReaderBlock[];
  zhBlocks: ReaderBlock[];
  units: { enBlockIds: string[]; zhBlockIds: string[] }[];
  spans: ReaderSpan[];
  contentHeight: { en: number; zh: number };
  stats: { enBlocks: number; zhBlocks: number; matchedUnits: number; unmatchedEn: number; unmatchedZh: number };
}

export interface SyncCommand {
  side: 'en' | 'zh';
  unitIndex: number;
  blockId: string;
  targetSide: 'en' | 'zh';
  targetBlockIds: string[];
  targetScrollTop: number;
  targetBlockTop: number;
}

export interface ReaderPosition {
  id: string;
  absTop: number;
  absBottom: number;
  pageIndex: number;
  rect: { y: number; h: number };
}

export interface ReaderPositionIndex {
  sorted: ReaderPosition[];
  byId: Map<string, ReaderPosition>;
}

export interface PdfPositionFragment {
  pageIndex: number;
  absTop: number;
  absBottom: number;
  rect: { x: number; y: number; w: number; h: number };
}

export interface PdfPosition {
  id: string;
  anchor: number;
  pageIndex: number;
  fragments: PdfPositionFragment[];
}

export interface PdfPositionIndex {
  sorted: PdfPosition[];
  byId: Map<string, PdfPosition>;
}

export interface PdfSyncCommand {
  side: 'en' | 'zh';
  targetSide: 'en' | 'zh';
  unitId: string;
  targetUnitId: string;
  targetPage: number;
  targetAnchor: number;
  targetScrollTop: number;
}

interface ReaderCore {
  buildPositionIndex(blocks: PositionedBlock[], pageH: number): any;
  buildMeasuredPositionIndex(
    measurements: { id: string; top: number; height: number }[],
    containerTop: number,
  ): ReaderPositionIndex;
  shouldSuppressScrollEcho(currentScrollTop: number, targetScrollTop: number, epsilon?: number): boolean;
  clampScrollTop(targetScrollTop: number, scrollHeight: number, clientHeight: number): number;
  buildPdfPositionIndex(
    units: Array<{ id: string; source?: Array<{ page: number; rects: Array<{ x: number; y: number; w: number; h: number }> }>; target?: Array<{ page: number; rects: Array<{ x: number; y: number; w: number; h: number }> }> }>,
    side: 'en' | 'zh',
    pageOffsets: number[],
    pageScales: number | number[],
  ): PdfPositionIndex;
  resolvePdfSyncCommand(input: {
    side: 'en' | 'zh';
    viewportCenter: number;
    sourceIndex: PdfPositionIndex;
    targetIndex: PdfPositionIndex;
    targetViewportHeight: number;
    targetScrollHeight?: number;
    unitMap?: Map<string, string> | Record<string, string>;
  }): PdfSyncCommand | null;
  locateBlockAtViewport(idx: any, scrollTop: number, viewportH: number): any;
  buildUnitIndex(units: { enBlockIds: string[]; zhBlockIds: string[] }[]): Map<string, number>;
  resolveSyncCommand(
    enIdx: any,
    zhIdx: any,
    units: { enBlockIds: string[]; zhBlockIds: string[] }[],
    unitIndex: Map<string, number>,
    side: 'en' | 'zh',
    scrollTop: number,
    viewportH: number,
  ): SyncCommand | null;
  createSyncController(lockMs?: number): { shouldSync(side: 'en' | 'zh', now: number): boolean; reset(): void };
  locateSubstringRange(fullText: string, sub: string): { start: number; end: number } | null;
  buildReaderModel(pkg: ReaderProjectPackage): ReaderModel;
}

const core = (globalThis as any).PaperParallelReader as ReaderCore;

export const buildPositionIndex = core.buildPositionIndex.bind(core) as ReaderCore['buildPositionIndex'];
export const buildMeasuredPositionIndex = core.buildMeasuredPositionIndex.bind(core) as ReaderCore['buildMeasuredPositionIndex'];
export const shouldSuppressScrollEcho = core.shouldSuppressScrollEcho.bind(core) as ReaderCore['shouldSuppressScrollEcho'];
export const clampScrollTop = core.clampScrollTop.bind(core) as ReaderCore['clampScrollTop'];
export const buildPdfPositionIndex = core.buildPdfPositionIndex.bind(core) as ReaderCore['buildPdfPositionIndex'];
export const resolvePdfSyncCommand = core.resolvePdfSyncCommand.bind(core) as ReaderCore['resolvePdfSyncCommand'];
export const locateBlockAtViewport = core.locateBlockAtViewport.bind(core) as ReaderCore['locateBlockAtViewport'];
export const buildUnitIndex = core.buildUnitIndex.bind(core) as ReaderCore['buildUnitIndex'];
export const resolveSyncCommand = core.resolveSyncCommand.bind(core) as ReaderCore['resolveSyncCommand'];
export const createSyncController = core.createSyncController.bind(core) as ReaderCore['createSyncController'];
export const locateSubstringRange = core.locateSubstringRange.bind(core) as ReaderCore['locateSubstringRange'];
export const buildReaderModel = core.buildReaderModel.bind(core) as ReaderCore['buildReaderModel'];
