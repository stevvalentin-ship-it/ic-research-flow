// ============================================================================
// regions.ts —— 图/表区域检测与题注关联、统一块序列
// 算法基准:P6 探针(合成夹具断言全部通过)。纯函数、零依赖。
// ============================================================================
import type { Rect } from '../../types/models';
import type { RawBlock } from './blocks';

export interface LineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 两个矩形是否重叠或接近(间隙 <= gap) */
export function rectsOverlapOrNear(a: Rect, b: Rect, gap = 8): boolean {
  return !(
    a.x > b.x + b.w + gap ||
    b.x > a.x + a.w + gap ||
    a.y > b.y + b.h + gap ||
    b.y > a.y + a.h + gap
  );
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * 位图矩形合并:同图被拆成多个 paintImageXObject 时合并;过滤过小噪点。
 */
export function mergeBitmapRegions(rects: Rect[], gap = 8, minArea = 1600): Rect[] {
  const list: Rect[] = rects.map((r) => ({ ...r }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < list.length && !merged; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (rectsOverlapOrNear(list[i], list[j], gap)) {
          list[i] = unionRect(list[i], list[j]);
          list.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return list.filter((r) => r.w * r.h >= minArea);
}

/**
 * 横竖线 -> 表格区域。
 * 规则:至少 2 条水平线与 2 条竖直线,线端彼此覆盖,构成网格;
 * bbox 以水平线网格的 y 范围为界(不取线端点外延)。
 */
export function detectTableRegions(
  hSegs: LineSegment[],
  vSegs: LineSegment[],
  minHLines = 2,
  minVLines = 2,
): Rect[] {
  const groupBy = (segs: LineSegment[], tol: number, axis: 'y1' | 'x1') =>
    segs.reduce<Record<number, LineSegment[]>>((m, s) => {
      const k = Math.round(s[axis] / tol);
      (m[k] = m[k] || []).push(s);
      return m;
    }, {});

  const hg = groupBy(hSegs, 2, 'y1');
  const vg = groupBy(vSegs, 2, 'x1');
  const hs = Object.values(hg).map((a) => ({
    pos: a[0].y1,
    min: Math.min(...a.map((s) => s.x1)),
    max: Math.max(...a.map((s) => s.x2)),
  }));
  const vs = Object.values(vg).map((a) => ({
    pos: a[0].x1,
    min: Math.min(...a.map((s) => s.y1)),
    max: Math.max(...a.map((s) => s.y2)),
  }));

  const regions: Rect[] = [];
  for (let i = 0; i < hs.length; i++) {
    for (let j = i + 1; j < hs.length; j++) {
      for (let m = 0; m < vs.length; m++) {
        for (let n = m + 1; n < vs.length; n++) {
          const y1 = Math.min(hs[i].pos, hs[j].pos);
          const y2 = Math.max(hs[i].pos, hs[j].pos);
          const x1 = Math.min(vs[m].pos, vs[n].pos);
          const x2 = Math.max(vs[m].pos, vs[n].pos);
          const hOk =
            hs[i].max >= x1 && hs[i].min <= x2 && hs[j].max >= x1 && hs[j].min <= x2;
          const vOk =
            vs[m].max >= y1 && vs[m].min <= y2 && vs[n].max >= y1 && vs[n].min <= y2;
          if (hOk && vOk) regions.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
        }
      }
    }
  }

  // 合并重叠/相邻候选
  const merged: Rect[] = [];
  for (const r of regions) {
    const hit = merged.find((m) => rectsOverlapOrNear(m, r, 4));
    if (hit) Object.assign(hit, unionRect(hit, r));
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.w > minVLines * 4 && r.h > minHLines * 4);
}

/** 题注与区域关联后形成的统一块 */
export interface UnifiedBlock extends RawBlock {
  caption?: string;
  captionSide?: 'above' | 'below';
  src: 'text' | 'region';
}

/**
 * 合并文字块与图/表区域:
 * - 图题通常在图下方、表题通常在表上方,两个方向都接受
 * - 题注被消费后从文本块中移除
 * - 统一按 通栏→左→右 阅读顺序排序(块级保序)
 */
export function unifyBlocks(
  textBlocks: RawBlock[],
  figureRects: Rect[],
  tableRects: Rect[],
  pageW: number,
  lineH = 13,
): UnifiedBlock[] {
  const captionMaxGap = lineH * 3;
  const blocks: (RawBlock & { used?: boolean })[] = textBlocks.map((b) => ({ ...b }));
  const captions = blocks.filter((b) => b.type === 'caption');

  const attach = (region: Rect, type: 'figure' | 'table'): UnifiedBlock => {
    let best: (typeof captions)[number] | null = null;
    let dist = Infinity;
    let side: 'above' | 'below' = 'below';
    for (const c of captions) {
      if (c.used) continue;
      const sameCol = region.x + region.w / 2 < pageW / 2 === c.rect.x < pageW / 2;
      if (!sameCol) continue;
      const below = c.rect.y - (region.y + region.h);
      const above = region.y - (c.rect.y + c.rect.h);
      for (const [g, s] of [
        [below, 'below'],
        [above, 'above'],
      ] as const) {
        if (g >= -2 && g <= captionMaxGap && g < dist) {
          best = c;
          dist = g;
          side = s;
        }
      }
    }
    if (best) {
      best.used = true;
      blocks.splice(blocks.indexOf(best), 1);
    }
    return {
      id: `${type}-${region.x.toFixed(0)}-${region.y.toFixed(0)}`,
      type,
      col: region.x + region.w / 2 < pageW / 2 ? 'left' : 'right',
      rect: region,
      text: '',
      lineCount: 0,
      order: -1,
      caption: best?.text,
      captionSide: best ? side : undefined,
      src: 'region',
    };
  };

  const regions: UnifiedBlock[] = [
    ...figureRects.map((r) => attach(r, 'figure')),
    ...tableRects.map((r) => attach(r, 'table')),
  ];

  const all: UnifiedBlock[] = [
    ...blocks.map((b) => ({ ...b, caption: undefined as string | undefined, src: 'text' as const })),
    ...regions,
  ];
  const rank = (c: RawBlock['col']) => (c === 'full' ? 0 : c === 'left' ? 1 : 2);
  all.sort((a, b) => rank(a.col) - rank(b.col) || a.rect.y - b.rect.y);
  all.forEach((b, i) => (b.order = i));
  return all;
}
