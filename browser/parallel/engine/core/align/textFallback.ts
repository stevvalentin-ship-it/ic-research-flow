import type { AlignmentRectSet, Rect } from '../../types/models';
import { normalizeTextItem } from '../parser/pdfjsAdapter';

export interface TargetTextSegment {
  id: string;
  targetText: string;
}

export interface TargetTextMatch {
  status: 'aligned' | 'unmatched';
  confidence: number;
  rects: AlignmentRectSet[];
}

interface TextItemLike {
  str?: string;
  rect?: Rect;
  hasEOL?: boolean;
  width?: number;
  height?: number;
  transform?: number[];
}

interface TextPageLike {
  getViewport(options: { scale: number }): { transform: number[] };
  getTextContent(): Promise<{ items: TextItemLike[] }>;
}

export interface TextPdfLike {
  numPages: number;
  getPage(pageNumber: number): Promise<TextPageLike>;
}

interface StreamChar {
  char: string;
  page: number;
  rect: Rect;
  itemKey: string;
}

function normalizeComparable(text: string): string {
  return [...text.normalize('NFKC')].filter((char) => !/\s/u.test(char)).join('');
}

function itemRect(item: TextItemLike, viewport: { transform: number[] }): Rect | null {
  if (item.rect) return { ...item.rect };
  if (!item.transform || item.width === undefined || item.height === undefined || !item.str) return null;
  const normalized = normalizeTextItem({
    str: item.str,
    width: item.width,
    height: item.height,
    transform: item.transform,
  }, viewport);
  return { x: normalized.x, y: normalized.y, w: normalized.w, h: normalized.h };
}

function startsAlphabetic(text: string): boolean {
  return /^\s*[A-Za-z]/.test(text);
}

async function buildTextStream(pdf: TextPdfLike): Promise<StreamChar[]> {
  const stream: StreamChar[] = [];
  for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const { items } = await page.getTextContent();
    const textItems = items.filter((item) => typeof item.str === 'string' && item.str.length > 0);
    textItems.forEach((item, itemIndex) => {
      const rect = itemRect(item, viewport);
      if (!rect || !item.str) return;
      const next = textItems[itemIndex + 1];
      const removesLineHyphen = item.hasEOL === true
        && item.str.endsWith('-')
        && Boolean(next?.str && startsAlphabetic(next.str));
      const raw = removesLineHyphen ? item.str.slice(0, -1) : item.str;
      const itemKey = `${pageIndex}:${itemIndex}`;
      for (const char of raw.normalize('NFKC')) {
        if (/\s/u.test(char)) continue;
        stream.push({ char, page: pageIndex, rect, itemKey });
      }
    });
  }
  return stream;
}

function geometryFromSlice(chars: StreamChar[]): AlignmentRectSet[] {
  const seen = new Set<string>();
  const pages = new Map<number, Rect[]>();
  for (const char of chars) {
    if (seen.has(char.itemKey)) continue;
    seen.add(char.itemKey);
    const rects = pages.get(char.page) ?? [];
    rects.push({ ...char.rect });
    pages.set(char.page, rects);
  }
  return [...pages.entries()]
    .sort(([left], [right]) => left - right)
    .map(([page, rects]) => ({ page, rects }));
}

export async function matchTranslatedText(
  pdf: TextPdfLike,
  segments: TargetTextSegment[],
): Promise<Map<string, TargetTextMatch>> {
  const stream = await buildTextStream(pdf);
  const searchable = stream.map((entry) => entry.char).join('');
  const matches = new Map<string, TargetTextMatch>();
  let cursor = 0;

  for (const segment of segments) {
    const target = normalizeComparable(segment.targetText);
    const start = target ? searchable.indexOf(target, cursor) : -1;
    if (start < 0) {
      matches.set(segment.id, { status: 'unmatched', confidence: 0, rects: [] });
      continue;
    }
    const end = start + target.length;
    matches.set(segment.id, {
      status: 'aligned',
      confidence: 1,
      rects: geometryFromSlice(stream.slice(start, end)),
    });
    cursor = end;
  }
  return matches;
}
