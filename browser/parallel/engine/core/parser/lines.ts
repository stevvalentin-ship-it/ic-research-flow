// ============================================================================
// lines.ts —— 文字层第一道工序:字符 items -> 行
// 算法基准:P5 探针(已通过合成夹具断言)。纯函数、零依赖,便于 Vitest 测试。
// ============================================================================
import type { TextRunGeometry } from './textGeometry';

/** 归一化后的简单文本项(视口坐标,scale=1)。pdfjs 坐标换算见 pdfjsAdapter。 */
export interface SimpleTextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Present for rotated runs whose characters do not advance along +x. */
  geometry?: TextRunGeometry;
}

/** 一行:同一 y 基线、且 x 连续的字符合并结果 */
export interface ParsedLine {
  y: number;
  x1: number;
  x2: number;
  h: number;
  text: string;
  items: SimpleTextItem[];
}

const Y_TOLERANCE = 4;   // 同一行 y 容差(px)
const X_GAP = 24;        // 同一基线内 x 间隙阈值:超过即视为另一栏的另一行
// IEEE two-column PDFs commonly leave only about 12pt between the final glyph
// of the left lane and the first glyph of the right lane. Keeping this above
// 16pt silently merges both physical lines and corrupts every later stage.
const CENTER_GUTTER_MIN = 10;

function crossesPageCenter(prev: SimpleTextItem, next: SimpleTextItem, pageW?: number): boolean {
  if (!pageW) return false;
  const center = pageW / 2;
  const gap = next.x - (prev.x + prev.w);
  const gutterThreshold = Math.max(CENTER_GUTTER_MIN, pageW * 0.018);
  return gap > gutterThreshold && prev.x + prev.w < center && next.x > center;
}

/**
 * items -> lines。
 * 1) y 容差内聚组;2) 组内按 x 排序,间隙 > X_GAP 拆行(防止左右两栏同行合并)。
 */
export function itemsToLines(items: SimpleTextItem[], pageW?: number): ParsedLine[] {
  const groups: { y: number; items: SimpleTextItem[] }[] = [];
  const lines: ParsedLine[] = [];

  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    // A rotated axis label's bounding-box top is not a horizontal baseline.
    // Keep its source run intact instead of merging it with adjacent prose.
    if (it.geometry) {
      lines.push({ y: it.y, items: [it], x1: it.x, x2: it.x + it.w, h: it.h, text: it.str });
      continue;
    }
    let g = groups.find((g) => Math.abs(g.y - it.y) <= Y_TOLERANCE);
    if (!g) {
      g = { y: it.y, items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }

  for (const g of groups) {
    g.items.sort((a, b) => a.x - b.x);
    let seg: SimpleTextItem[] = [];
    const flush = () => {
      if (!seg.length) return;
      lines.push({
        y: g.y,
        items: seg,
        x1: seg[0].x,
        x2: Math.max(...seg.map((i) => i.x + i.w)),
        h: Math.max(...seg.map((i) => i.h)),
        text: seg.map((i) => i.str).join(' '),
      });
    };
    for (const it of g.items) {
      if (seg.length) {
        const prev = seg[seg.length - 1];
        if (it.x - (prev.x + prev.w) > X_GAP || crossesPageCenter(prev, it, pageW)) {
          flush();
          seg = [];
        }
      }
      seg.push(it);
    }
    flush();
  }
  lines.sort((a, b) => a.y - b.y);
  return lines;
}
