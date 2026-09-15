// ============================================================================
// blocks.ts —— 行 -> 块切分
// 算法基准:P5 探针(合成夹具断言已通过)。纯函数、零依赖。
// 块级保序 R5:先按通栏边界划分垂直区域,区域内按左栏→右栏阅读。
// ============================================================================
import type { ClassifiedLine, ColumnKind } from './columns';
import type { BlockType, CharacterRect, Rect } from '../../types/models';
import { itemsToCharRects } from './charRects';
import { readingBands } from './readingOrder';

/** 解析器产出的原始块(尚未装配 docId/pageIndex 等文档上下文) */
export interface RawBlock {
  id: string;
  type: BlockType;
  col: ColumnKind;
  rect: Rect;
  text: string;
  lineCount: number;
  order: number;
  characterRects?: CharacterRect[];
}

const COLUMN_ORDER: ColumnKind[] = ['full', 'left', 'right'];

export interface ColumnBounds {
  min: number;
  max: number;
}

function hasCaptionSuffix(suffix: string | undefined): boolean {
  if (suffix === undefined) return false;
  const trimmed = suffix.trimStart();
  if (!trimmed) return true;
  // A wrapped body sentence can begin with a cross-reference such as
  // "Figure 11. The sub-task size ...".  Treat that demonstrative sentence
  // continuation as prose, not as a caption that owns the pixels above it.
  if (/^[.]\s+(?:the|this|these|those|it|we|our|a|an)\b/i.test(trimmed)) return false;
  if (/^[:：.\-–—]/.test(trimmed)) return true;
  return trimmed.length < suffix.length && /^[A-Z\u4e00-\u9fff]/.test(trimmed);
}

export function isFigureCaptionText(text: string): boolean {
  return text.split(/\r?\n/).some((line) => (
    // IEEE captions conventionally begin with the abbreviated "Fig." and
    // often continue with "The ...". The demonstrative-sentence guard in
    // hasCaptionSuffix is intended for body references written as "Figure
    // 11. The ...", not for an explicit abbreviated caption.
    /^fig[.]\s*(?:\d+(?:[.-]\d+)*|[IVXLCDM]+)\s*[.:：\-–—]/i.test(line.trim())
    || hasCaptionSuffix(line.trim().match(/^fig(?:ure)?\.?\s*(?:\d+(?:[.-]\d+)*|[IVXLCDM]+)(.*)$/i)?.[1])
  ));
}

export function isTableCaptionText(text: string): boolean {
  return text.split(/\r?\n/).some((line) => (
    hasCaptionSuffix(line.trim().match(/^table\s*(?:\d+(?:[.-]\d+)*|[IVXLCDM]+)(.*)$/i)?.[1])
  ));
}

export function isAlgorithmCaptionText(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const match = line.trim().match(/^algorithm\s*(?:\d+(?:[.-]\d+)*|[IVXLCDM]+)(.*)$/i);
    if (!match) return false;
    const suffix = match[1] ?? '';
    const trimmed = suffix.trimStart();
    if (!trimmed) return true;
    if (/^[.:：\-–—]/.test(trimmed)) return true;
    if (trimmed.length === suffix.length) return false;
    // Function names in algorithm titles often begin with a lowercase letter
    // (for example pBucketPointsReduction). Exclude common prose-reference
    // verbs instead of requiring title case.
    return !/^(?:is|are|was|were|shows?|presents?|describes?|illustrates?|uses?|contains?|requires?)\b/i.test(trimmed);
  });
}

function isNumberedCaptionText(text: string): boolean {
  const trimmed = text.trim();
  return isFigureCaptionText(trimmed)
    || isTableCaptionText(trimmed)
    || isAlgorithmCaptionText(trimmed)
    || hasCaptionSuffix(trimmed.match(/^[图表]\s*(?:\d+(?:[.-]\d+)*|[IVXLCDM]+)(.*)$/i)?.[1]);
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}

export function isDisplayFormulaCandidate(text: string, centered: boolean): boolean {
  if (!centered) return false;
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 180) return false;

  const naturalWords = normalized.match(/[A-Za-z]{3,}/g) ?? [];
  if (naturalWords.length > 5) return false;
  const functionWords = normalized.match(
    /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|if|when|where|whether|we|need)\b/gi,
  ) ?? [];
  // A prose sentence can contain enough variables and operators to score as
  // mathematics (for example, "whether it contains P_i + P_t, where ...").
  // Keeping that whole line as source pixels leaves a conspicuous English
  // sentence in the translated paper. Natural-language syntax is decisive.
  if (naturalWords.length >= 3 && functionWords.length >= 1) return false;

  const relations = normalized.match(/(?:=|≠|≈|≤|≥|<|>)/g) ?? [];
  const operators = normalized.match(/[+*/^{}×÷√∑∫]/g) ?? [];
  const variables = normalized.match(/(?:^|[\s,(])[A-Za-z](?:_[A-Za-z0-9]+)?(?=$|[\s,)=+*/^])/g) ?? [];
  const numbered = /\(\d+[a-z]?\)\s*$/i.test(normalized);
  const mathScore = relations.length * 2 + operators.length + Math.min(variables.length, 3);

  if (relations.length && mathScore >= 3) return true;
  if (numbered && mathScore >= 3) return true;
  return naturalWords.length <= 2 && mathScore >= 5;
}

function looksLikeFrontMatterAuthorList(text: string): boolean {
  if (!/[,，]|\band\b/i.test(text)) return false;
  const hasAffiliationMarker = /\b\d+(?:\s*,\s*\d+)*\b/.test(text);
  const cleaned = text
    .replace(/\(\s*[A-Z]\s*\)/g, ' ')
    .replace(/\b\d+(?:\s*,\s*\d+)*\b/g, ' ')
    .replace(/\band\b/gi, ',');
  const nameToken = String.raw`(?:[A-Z][A-Za-z'’-]+|[A-Z][.])`;
  const namePattern = new RegExp(`^${nameToken}(?:\\s+${nameToken}){1,4}$`);
  const names = cleaned
    .split(/[,，]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => namePattern.test(segment));
  return names.length >= 3 || (hasAffiliationMarker && names.length >= 2);
}

function classifyLineRole(l: ClassifiedLine, col: ColumnBounds, pageH: number): RawBlock['type'] {
  const t = l.text.trim();
  const compactLetters = t.replace(/\s+/g, '');
  const colCenter = (col.min + col.max) / 2;
  const lineCenter = (l.x1 + l.x2) / 2;
  const centered = Math.abs(lineCenter - colCenter) <= Math.max(20, (col.max - col.min) * 0.12);

  // 通栏区:标题/作者/摘要/关键词
  if (/^(abstract|摘要)[\s—\-:：]/i.test(t)) return 'abstract';
  if (/^key ?words|^关键词/i.test(t)) return 'keywords';
  if (l.col === 'full') {
    const inFrontMatter = l.y < Math.min(300, pageH * 0.38);
    if (inFrontMatter && /\b(?:member\s*,?\s*IEEE|IEEE\s+(?:member|fellow))\b/i.test(t)) return 'authors';
    if (inFrontMatter && looksLikeFrontMatterAuthorList(t)) return 'authors';
    if (inFrontMatter && /[,，]/.test(t) && /university|大学|学院|实验室|lab/i.test(t)) return 'authors';
    if (t.length < 90 && l.h >= 14) return 'title';
  }

  // 章节标题:数字编号 + 短文本;排除"2021 IEEE..."这类文献行(含逗号/句末标点)
  const numberedHeading = /^\s*\d{1,2}(?:\.\d+)*\.?\s+[A-Z\u4e00-\u9fa5]/i.test(t);
  // Roman IEEE section numbers always carry a period. Requiring it prevents
  // ordinary words made only of Roman letters ("LIMM ...") and detached
  // subscripts ("c c", "i t") from becoming headings.
  const romanHeading = /^\s*[IVXLCDM]+\.\s+[A-Z\u4e00-\u9fa5]/.test(t);
  const alphabeticHeading = /^\s*[A-Z]\.\s+[A-Z\u4e00-\u9fa5]/.test(t);
  if (
    (numberedHeading || romanHeading || alphabeticHeading) &&
    t.length < 80 &&
    !/[.!?。！？]$/.test(t) &&
    !/[,;]/.test(t) &&
    !/^\d+\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(t)
  )
    return 'section';
  if (/^(references|bibliography|acknowledge?ments?|参考文献|致谢)\s*$/i.test(compactLetters)) return 'section';

  // 图表题注
  if (isNumberedCaptionText(t))
    return 'caption';

  // 独立公式:短、居中、含数学符号或右端编号
  if (isDisplayFormulaCandidate(t, centered)) return 'equation';

  // 参考文献
  // Multiple leading citations followed by prose are a body continuation,
  // not the beginning of a bibliography entry.
  if (/^\[\d+\]/.test(t) && !/^\[\d+\](?:\s*,\s*\[\d+\])+\s+\S/.test(t)) return 'reference';

  return 'paragraph';
}

/**
 * 行 -> 块。断块规则:
 * - 角色变化(标题/题注/公式/正文)立即断块
 * - 同角色但垂直空白 > max(栏内中位行距*1.4, 行高中位数*1.5, 18px) 断块
 * - 通栏内容分隔上下区域,每个双栏区域内先左后右
 */
export function groupLinesToBlocks(
  lines: ClassifiedLine[],
  pageW: number,
  pageH: number,
): RawBlock[] {
  const byCol: Record<ColumnKind, ClassifiedLine[]> = { full: [], left: [], right: [] };
  for (const l of lines) byCol[l.col].push(l);

  // 每个栏的 x 范围(由该栏行坐标推算)
  const colBounds: Record<ColumnKind, ColumnBounds> = {
    full: { min: 0, max: pageW },
    left: { min: 0, max: pageW / 2 },
    right: { min: pageW / 2, max: pageW },
  };
  for (const c of COLUMN_ORDER) {
    const arr = byCol[c];
    if (arr.length) {
      colBounds[c] = {
        min: Math.min(...arr.map((l) => l.x1)),
        max: Math.max(...arr.map((l) => l.x2)),
      };
    }
  }

  const blocks: RawBlock[] = [];
  let n = 0;
  const push = (type: RawBlock['type'], ls: ClassifiedLine[]) => {
    if (!ls.length) return;
    const y1 = Math.min(...ls.map((l) => l.y));
    const y2 = Math.max(...ls.map((l) => l.y + l.h));
    const x1 = Math.min(...ls.map((l) => l.x1));
    const x2 = Math.max(...ls.map((l) => l.x2));
    const characterRects: CharacterRect[] = [];
    let sourceOffset = 0;
    ls.forEach((line, lineIndex) => {
      if (lineIndex > 0) sourceOffset += 1; // block text joins visual lines with "\n"
      const chars = itemsToCharRects(line.items, {
        pageIndex: 0,
        sourceOffset,
        itemSeparator: ' ',
      });
      characterRects.push(...chars.map((char) => ({
        ch: char.ch,
        sourceIndex: char.sourceIndex!,
        pageIndex: 0,
        rect: { x: char.x, y: char.y, w: char.w, h: char.h },
      })));
      sourceOffset += line.text.length;
    });
    blocks.push({
      id: `blk${++n}`,
      type,
      col: ls[0].col,
      rect: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
      text: ls.map((l) => l.text).join('\n'),
      lineCount: ls.length,
      order: -1,
      characterRects,
    });
  };

  const bands = readingBands(lines, (line) => ({ x: line.x1, y: line.y, w: line.x2 - line.x1, h: line.h }));
  const lanes = bands.flatMap((band) => COLUMN_ORDER.map((col) => band.filter((line) => line.col === col)));
  for (const arr of lanes) {
    if (!arr.length) continue;
    const c = arr[0]!.col;
    arr.sort((a, b) => a.y - b.y);

    const gaps: number[] = [];
    for (let i = 1; i < arr.length; i++) gaps.push(arr[i].y - arr[i - 1].y);
    const medianGap = gaps.length ? median(gaps) : 12;
    const lineH = median(arr.map((l) => l.h));
    const BREAK = Math.max(medianGap * 1.4, lineH * 1.5, 18);

    let curType: RawBlock['type'] | null = null;
    let cur: ClassifiedLine[] = [];
    const flush = () => {
      if (cur.length && curType) push(curType, cur);
      curType = null;
      cur = [];
    };

    for (let i = 0; i < arr.length; i++) {
      const l = arr[i];
      const role = classifyLineRole(l, colBounds[c], pageH);
      const prev = arr[i - 1];
      const bigGap = prev ? l.y - (prev.y + prev.h) > BREAK : false;
      const rotatedBoundary = l.items.some((item) => Boolean(item.geometry))
        || prev?.items.some((item) => Boolean(item.geometry));
      if (cur.length && (bigGap || role !== curType || rotatedBoundary)) flush();
      if (!cur.length) curType = role;
      cur.push(l);
    }
    flush();
  }

  blocks.forEach((b, i) => (b.order = i));
  return blocks;
}
