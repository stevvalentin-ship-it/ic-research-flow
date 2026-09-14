// ============================================================================
// docBuilder.ts —— 跨页装配:逐页解析结果 -> 统一 Doc
// 算法基准:P7 探针(合成双页夹具 8 项断言全部通过)。纯函数、零依赖。
// ============================================================================
import type {
  Block, BlockFragment, CharacterRect, Doc, LayoutMode, PageInfo, Rect, SemanticUnitKind,
} from '../../types/models';
import { buildLayoutRegions } from '../layout/regions';
import type { ColumnKind } from './columns';
import { readingOrder } from './readingOrder';

/** 单页解析器产物(由 parsePageItems + regions 检测装配而来) */
export interface ParsedPageBlock {
  id: string;
  type: Block['type'];
  col: ColumnKind;
  rect: Rect;
  text: string;
  characterRects?: CharacterRect[];
}

export interface ParsedPage {
  no: number;
  w: number;
  h: number;
  layoutMode: LayoutMode;
  blocks: ParsedPageBlock[];
}

type WorkBlock = ParsedPageBlock & {
  pageIndex: number;
  fragments: BlockFragment[];
  prevBlockId?: string;
  nextBlockId?: string;
  parentSectionId?: string;
  widthMode: 'span' | 'column';
  splitAllowed: boolean;
  order: number;
};

const ATOMIC_TYPES = new Set<Block['type']>(['figure', 'table', 'equation', 'caption']);

function isSuspiciousSectionBlock(block: WorkBlock): boolean {
  if (block.type !== 'section') return false;
  const text = block.text.replace(/\s+/g, ' ').trim();
  if (!text || /^(?:references|bibliography|acknowledge?ments?)\s*$/i.test(text)) return false;
  if (block.rect.h < 8.5) return true;
  if (/^\d+(?:[.]\d+)?\s*(?:GHz|[kMGT]?B|bits?|x\b|[a-z]\s*[−-]\s*\d)/i.test(text)) return true;
  if (/^\d{1,2}\s+[a-z]\b/.test(text)) return true;
  const bareNumber = text.match(/^\d{1,2}\s+(.+)$/)?.[1];
  if (!bareNumber) return false;
  const words = bareNumber.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  const functionWords = words.filter((word) => (
    /^(?:a|an|and|as|at|by|for|from|in|is|it|of|on|or|since|that|the|this|to|was|were|which|with)$/i.test(word)
  ));
  return words.length >= 7 && functionWords.length >= 2;
}

function unionCharacterRects(characters: CharacterRect[]): Rect {
  const x1 = Math.min(...characters.map((char) => char.rect.x));
  const y1 = Math.min(...characters.map((char) => char.rect.y));
  const x2 = Math.max(...characters.map((char) => char.rect.x + char.rect.w));
  const y2 = Math.max(...characters.map((char) => char.rect.y + char.rect.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

interface CharacterRow {
  y: number;
  h: number;
  characters: CharacterRect[];
}

function groupCharactersIntoRows(characters: CharacterRect[], sourceText: string): CharacterRow[] {
  const sorted = [...characters].sort(
    (a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x,
  );
  const sourceLineStarts = [0];
  for (let index = 0; index < sourceText.length; index += 1) {
    if (sourceText[index] === '\n') sourceLineStarts.push(index + 1);
  }
  if (sourceLineStarts.length > 1) {
    const sourceRows = sourceLineStarts.map((): CharacterRow => ({
      y: Number.POSITIVE_INFINITY,
      h: 0,
      characters: [],
    }));
    for (const character of characters) {
      let lineIndex = 0;
      for (let index = 1; index < sourceLineStarts.length; index += 1) {
        if (sourceLineStarts[index]! > character.sourceIndex) break;
        lineIndex = index;
      }
      const row = sourceRows[lineIndex]!;
      row.characters.push(character);
      const oldBottom = Number.isFinite(row.y) ? row.y + row.h : character.rect.y;
      const top = Math.min(row.y, character.rect.y);
      const bottom = Math.max(oldBottom, character.rect.y + character.rect.h);
      row.y = top;
      row.h = bottom - top;
    }
    return sourceRows.filter((row) => row.characters.length > 0);
  }
  const rows: CharacterRow[] = [];
  for (const character of sorted) {
    const center = character.rect.y + character.rect.h / 2;
    const row = rows.find((candidate) => (
      Math.abs(center - (candidate.y + candidate.h / 2))
        <= Math.max(2, Math.min(character.rect.h, candidate.h) * 0.35)
    ));
    if (row) {
      row.characters.push(character);
      const top = Math.min(row.y, character.rect.y);
      const bottom = Math.max(row.y + row.h, character.rect.y + character.rect.h);
      row.y = top;
      row.h = bottom - top;
    } else {
      rows.push({
        y: character.rect.y,
        h: character.rect.h,
        characters: [character],
      });
    }
  }
  return rows.sort((a, b) => a.y - b.y);
}

function columnTextFromCharacters(
  rows: CharacterRow[],
  sourceText: string,
  side: 'left' | 'right',
  midpoint: number,
): { text: string; characterRects: CharacterRect[]; rect: Rect } | null {
  let text = '';
  const characterRects: CharacterRect[] = [];

  for (const row of rows) {
    const lane = row.characters
      .filter((character) => (
        side === 'left'
          ? character.rect.x + character.rect.w / 2 < midpoint
          : character.rect.x + character.rect.w / 2 >= midpoint
      ))
      .sort((a, b) => a.rect.x - b.rect.x);
    if (!lane.length) continue;
    if (text.length) text += '\n';

    let previous: CharacterRect | undefined;
    for (const character of lane) {
      if (previous) {
        const sourceGap = sourceText.slice(previous.sourceIndex + 1, character.sourceIndex);
        const visualGap = character.rect.x - (previous.rect.x + previous.rect.w);
        if (/^\s+$/.test(sourceGap) || visualGap > Math.max(1.5, previous.rect.h * 0.18)) {
          text += ' ';
        }
      }
      characterRects.push({ ...character, sourceIndex: text.length });
      text += character.ch;
      previous = character;
    }
  }

  if (!characterRects.length) return null;
  return { text, characterRects, rect: unionCharacterRects(characterRects) };
}

/**
 * Some tagged IEEE PDFs expose both visual columns as one text line. The line
 * classifier consequently labels a whole page-height paragraph as `full` and
 * its text alternates left/right on every row. Recover the two reading lanes
 * from character geometry before assigning global block order.
 */
function splitInterleavedTwoColumnBlock(
  block: ParsedPageBlock,
  pageWidth: number,
  pageHeight: number,
): ParsedPageBlock[] {
  const characters = block.characterRects ?? [];
  const splittableType = block.type === 'paragraph'
    || block.type === 'authors'
    || block.type === 'abstract'
    || block.type === 'caption'
    || block.type === 'reference';
  if (
    block.col !== 'full'
    || !splittableType
    || characters.length < 24
    || block.rect.w < pageWidth * 0.54
  ) return [block];

  const naturalWords = block.text.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0;
  const numericTokens = block.text.match(/\d+(?:[.,]\d+)?/g)?.length ?? 0;
  if (numericTokens >= 12 && numericTokens > naturalWords * 0.5) return [block];

  const midpoint = pageWidth / 2;
  const rows = groupCharactersIntoRows(characters, block.text);
  if (!rows.length) return [block];

  const dualLaneRows = rows.filter((row) => {
    const left = row.characters.filter(
      (character) => character.rect.x + character.rect.w / 2 < midpoint,
    );
    const right = row.characters.filter(
      (character) => character.rect.x + character.rect.w / 2 >= midpoint,
    );
    if (left.length < 4 || right.length < 4) return false;
    const leftEdge = Math.max(...left.map((character) => character.rect.x + character.rect.w));
    const rightEdge = Math.min(...right.map((character) => character.rect.x));
    // A normal justified word space is not a gutter. Require a gap at least
    // as wide as the line parser's gutter and corroboration across the rows.
    return rightEdge - leftEdge >= Math.max(10, pageWidth * 0.018, row.h);
  });
  if (dualLaneRows.length < 1 || dualLaneRows.length / rows.length < 0.6) return [block];

  const left = columnTextFromCharacters(rows, block.text, 'left', midpoint);
  const right = columnTextFromCharacters(rows, block.text, 'right', midpoint);
  if (!left || !right) return [block];

  const proseMetrics = (text: string): { words: number; functionWords: number } => {
    const words = text.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
    const functionWords = words.filter((word) => /^(?:a|an|and|as|at|by|for|from|in|is|it|of|on|or|that|the|this|to|was|were|which|with)$/i.test(word));
    return { words: words.length, functionWords: functionWords.length };
  };
  const leftMetrics = proseMetrics(left.text);
  const rightMetrics = proseMetrics(right.text);
  const completeLane = (metrics: ReturnType<typeof proseMetrics>) => (
    metrics.words >= 6 && metrics.functionWords >= 2
  );
  const proseFragment = (metrics: ReturnType<typeof proseMetrics>) => (
    metrics.words >= 3 && metrics.functionWords >= 1
  );
  if (!(
    (completeLane(leftMetrics) && proseFragment(rightMetrics))
    || (completeLane(rightMetrics) && proseFragment(leftMetrics))
  )) return [block];

  const recoveredType = block.type === 'authors' && block.rect.y > pageHeight * 0.2
    ? 'paragraph'
    : block.type;

  return [
    {
      ...block,
      id: `${block.id}-left`,
      type: recoveredType,
      col: 'left',
      rect: left.rect,
      text: left.text,
      characterRects: left.characterRects,
    },
    {
      ...block,
      id: `${block.id}-right`,
      type: recoveredType,
      col: 'right',
      rect: right.rect,
      text: right.text,
      characterRects: right.characterRects,
    },
  ];
}

function isContinuable(b: ParsedPageBlock): boolean {
  return (
    b.type === 'paragraph' &&
    !/[。！？.!?；;:：]$/.test((b.text || '').trim()) &&
    b.text.trim().length > 0
  );
}

function startsLikeHeading(b: ParsedPageBlock): boolean {
  const t = (b.text || '').trim();
  return (
    /^\s*(\d{1,2}(\.\d+)*|IV|V|VI|VII|VIII|IX|X)\s+[A-Z\u4e00-\u9fa5]/.test(t) ||
    /^(fig(ure)?\.?|table|algorithm)\s*\d+/i.test(t) ||
    /^[图表]\s*\d+/.test(t)
  );
}

function lastFragmentPage(b: WorkBlock): number {
  return b.fragments[b.fragments.length - 1]?.pageIndex ?? b.pageIndex;
}

function liesAcrossPageBoundary(
  previous: WorkBlock,
  next: WorkBlock,
  pageHeights: ReadonlyMap<number, number>,
): boolean {
  const previousRect = previous.fragments.at(-1)?.rect ?? previous.rect;
  const pageHeight = pageHeights.get(lastFragmentPage(previous)) ?? 792;
  return previousRect.y + previousRect.h >= pageHeight * 0.72
    && next.rect.y <= pageHeight * 0.35;
}

function isRunningPageFurniture(block: ParsedPageBlock, pageHeight: number): boolean {
  const normalized = (block.text || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return false;
  const nearTop = block.rect.y < pageHeight * 0.12;
  const nearBottom = block.rect.y + block.rect.h > pageHeight * 0.92;
  if (nearTop && /^(?:\d+|IEEE\s+TRANSACTIONS\b|.+\bet\s+al[.]\s*:\s*.+)$/i.test(normalized)) {
    return true;
  }
  return nearBottom && (/^\d+$/.test(normalized) || /^Authorized licensed use limited to\b/i.test(normalized));
}

/** 两遍法合并:先接上一页阅读顺序末尾→下一页开头,再接同页左→右栏 */
function mergePass(
  list: WorkBlock[],
  allowCrossPage: boolean,
  allowCrossCol: boolean,
  pageHeights: ReadonlyMap<number, number>,
): WorkBlock[] {
  const out: WorkBlock[] = [];
  const seenPages = new Set<number>();
  for (const b of list) {
    const firstInPage = !seenPages.has(b.pageIndex);
    seenPages.add(b.pageIndex);
    const prev = out[out.length - 1];
    if (
      prev &&
      isContinuable(prev) &&
      b.type === 'paragraph' &&
      !startsLikeHeading(b)
    ) {
      const crossPage =
        allowCrossPage &&
        firstInPage &&
        b.pageIndex === lastFragmentPage(prev) + 1 &&
        liesAcrossPageBoundary(prev, b, pageHeights);
      const crossCol =
        allowCrossCol &&
        b.pageIndex === lastFragmentPage(prev) &&
        prev.col === 'left' &&
        b.col === 'right' &&
        liesAcrossPageBoundary(prev, b, pageHeights);
      if (crossPage || crossCol) {
        const sourceOffset = (prev.text || '').length + 1;
        prev.text = `${prev.text || ''}\n${b.text || ''}`;
        prev.fragments.push({ pageIndex: b.pageIndex, rect: b.rect });
        prev.characterRects = [
          ...(prev.characterRects ?? []),
          ...(b.characterRects ?? []).map((char) => ({
            ...char,
            sourceIndex: char.sourceIndex + sourceOffset,
          })),
        ];
        continue;
      }
    }
    out.push({
      ...b,
      fragments: b.fragments.length
        ? [...b.fragments]
        : [{ pageIndex: b.pageIndex, rect: b.rect }],
    });
  }
  return out;
}

export function buildDoc(pages: ParsedPage[], docId: 'en' | 'zh'): Doc {
  // 1) 每页按阅读顺序展开成带 pageIndex 的全局序列
  const seq: WorkBlock[] = [];
  for (const pg of pages) {
    const recoveredBlocks = (pg.layoutMode === 'single'
      ? pg.blocks
      : pg.blocks.flatMap((block) => splitInterleavedTwoColumnBlock(block, pg.w, pg.h)))
      // Running headers, page numbers and publisher download footers are not
      // document content. Removing them before the cross-page merge lets the
      // real first body paragraph continue the previous page instead of being
      // stranded behind a header block.
      .filter((block) => !isRunningPageFurniture(block, pg.h));
    const sorted = pg.layoutMode === 'single'
      ? [...recoveredBlocks].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
      : readingOrder(recoveredBlocks, (block) => block.rect);
    for (const b of sorted) {
      seq.push({
        ...b,
        pageIndex: pg.no,
        characterRects: b.characterRects?.map((char) => ({
          ...char,
          pageIndex: pg.no - 1,
        })),
        fragments: [],
        widthMode: 'column',
        splitAllowed: true,
        order: -1,
      });
    }
  }

  // 2) 续接合并:第一遍跨页阅读顺序末尾→开头,第二遍同页左→右
  const pageHeights = new Map(pages.map((page) => [page.no, page.h] as const));
  const merged = mergePass(
    mergePass(seq, true, false, pageHeights),
    false,
    true,
    pageHeights,
  );
  const firstPageIndex = Math.min(...merged.map((block) => block.fragments[0]?.pageIndex ?? block.pageIndex));

  // 3) 两遍赋值:先统一换新 id,再建 prev/next 链与章节归属
  //    (不能在单遍里取 merged[i+1].id,否则拿到的是尚未替换的旧 id)
  merged.forEach((b, i) => {
    b.id = `blk-${i + 1}`;
    b.order = i;
    b.pageIndex = b.fragments[0].pageIndex;
    const sourcePageHeight = pages.find((page) => page.no === b.pageIndex)?.h ?? pages[0]?.h ?? 792;
    if (b.type === 'authors'
      && (b.pageIndex !== firstPageIndex || b.rect.y > sourcePageHeight * 0.38)) b.type = 'paragraph';
    if (isSuspiciousSectionBlock(b)) b.type = 'paragraph';
    b.widthMode = b.col === 'full' ? 'span' : 'column';
    b.splitAllowed = !ATOMIC_TYPES.has(b.type);
  });
  let currentSectionId: string | undefined;
  merged.forEach((b, i) => {
    b.prevBlockId = i > 0 ? merged[i - 1].id : undefined;
    b.nextBlockId = i < merged.length - 1 ? merged[i + 1].id : undefined;
    if (b.type === 'section') {
      currentSectionId = b.id;
      b.parentSectionId = currentSectionId;
    } else {
      b.parentSectionId = currentSectionId;
    }
  });

  // 4) 版式:整体 = 任一页 mixed 则 mixed;否则任一页 double 则 double
  const layoutMode: LayoutMode = pages.some((p) => p.layoutMode === 'mixed')
    ? 'mixed'
    : pages.some((p) => p.layoutMode === 'double')
      ? 'double'
      : 'single';

  const pageInfos: PageInfo[] = pages.map((p) => ({
    pageIndex: p.no - 1,
    width: p.w,
    height: p.h,
    columns: [], // 由栏检测结果回填(本模块不负责)
  }));

  const blocks: Block[] = merged.map((b) => ({
    id: b.id,
    docId,
    type: b.type,
    pageIndex: b.pageIndex,
    rect: b.rect,
    order: b.order,
    prevBlockId: b.prevBlockId,
    nextBlockId: b.nextBlockId,
    fragments: b.fragments,
    text: b.text,
    characterRects: b.characterRects,
    widthMode: b.widthMode,
    parentSectionId: b.parentSectionId,
    splitAllowed: b.splitAllowed,
  }));

  const layoutRegions = buildLayoutRegions({
    pageWidth: pages[0]?.w ?? 0,
    pageModes: Object.fromEntries(pages.map((page) => [page.no, page.layoutMode])),
    blocks: merged.map((block) => ({
      id: block.id,
      pageIndex: block.pageIndex,
      order: block.order,
      col: block.col,
      rect: block.rect,
    })),
  });
  const regionByUnit = new Map(
    layoutRegions.flatMap((region) => region.orderedUnitIds.map((id) => [id, region.id] as const)),
  );
  const semanticKind: Record<Block['type'], SemanticUnitKind> = {
    title: 'title', authors: 'author', abstract: 'abstract', keywords: 'keywords',
    section: 'heading', paragraph: 'paragraph', figure: 'figure', table: 'table',
    equation: 'formula', caption: 'caption', reference: 'reference', other: 'paragraph',
  };
  const semanticUnits = blocks.map((block) => ({
    id: block.id,
    parentId: block.parentSectionId,
    kind: semanticKind[block.type],
    sourceText: block.text,
    protectedTokens: [],
    assetId: ['figure', 'table', 'equation'].includes(block.type) ? block.id : undefined,
    layoutRegionId: regionByUnit.get(block.id)!,
    order: block.order,
  }));

  return {
    id: docId,
    role: docId === 'zh' ? 'zh' : 'en',
    pageCount: pages.length,
    pages: pageInfos,
    blocks,
    layoutRegions,
    semanticUnits,
    layoutMode,
    meta: {
      paperWidth: pages[0]?.w ?? 0,
      paperHeight: pages[0]?.h ?? 0,
      title: blocks.find((b) => b.type === 'title')?.text,
    },
  };
}
