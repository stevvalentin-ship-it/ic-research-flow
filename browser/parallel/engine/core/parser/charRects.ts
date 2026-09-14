// ============================================================================
// charRects.ts —— 字符级坐标(词级联动高亮的数据基础)
// PDF.js 的 TextItem 只给整串宽度,第一版按字符等分 item 宽度。
// 后续可接 canvas measureText 做精确分配;等分对 CJK 与等宽数字已足够。
// ============================================================================
import type { Rect } from '../../types/models';
import type { SimpleTextItem } from './lines';
import { textRunRect } from './textGeometry';

export interface CharRect {
  ch: string;
  x: number;
  y: number;
  w: number;
  h: number;
  sourceIndex?: number;
  pageIndex?: number;
}

export function itemsToCharRects(
  items: SimpleTextItem[],
  options: { pageIndex?: number; sourceOffset?: number; itemSeparator?: string } = {},
): CharRect[] {
  const out: CharRect[] = [];
  const separator = options.itemSeparator ?? '';
  let sourceIndex = options.sourceOffset ?? 0;
  for (const it of items) {
    if (out.length) sourceIndex += separator.length;
    const n = it.str.length;
    if (!n) continue;
    const w = it.w / n;
    for (let i = 0; i < n; i++) {
      const rect = it.geometry
        ? textRunRect(it.geometry, i / n, (i + 1) / n)
        : { x: it.x + i * w, y: it.y, w, h: it.h };
      out.push({
        ch: it.str[i],
        sourceIndex: sourceIndex + i,
        pageIndex: options.pageIndex,
        ...rect,
      });
    }
    sourceIndex += n;
  }
  return out;
}

/** 由字符矩形反查某文本片段在视口中的覆盖矩形(跨行时返回多个) */
export function rectsForRange(chars: CharRect[], range: [number, number]): Rect[] {
  const [start, end] = range;
  const out: Rect[] = [];
  let cur: Rect | null = null;
  for (let i = start; i < end && i < chars.length; i++) {
    const c = chars[i];
    if (!cur) {
      cur = { x: c.x, y: c.y, w: c.w, h: c.h };
    } else if (Math.abs(c.y - cur.y) <= 2 && c.x <= cur.x + cur.w + 4 && cur.x <= c.x + c.w + 4) {
      const x1 = Math.min(cur.x, c.x);
      const x2 = Math.max(cur.x + cur.w, c.x + c.w);
      cur.x = x1;
      cur.w = x2 - x1;
    } else {
      out.push(cur);
      cur = { x: c.x, y: c.y, w: c.w, h: c.h };
    }
  }
  if (cur) out.push(cur);
  return out;
}
