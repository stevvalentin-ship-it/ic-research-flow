// ============================================================================
// pdfjsAdapter.ts —— 把 pdf.js 的 TextItem 换算成解析器需要的视口坐标
// 与 pdfjs 解耦:解析器只认 SimpleTextItem;换算矩阵算法来自 P4 探针。
// ============================================================================
import type { SimpleTextItem } from './lines';
import { textRunRect, type TextRunGeometry } from './textGeometry';

export interface PdfTextItemLike {
  str: string;
  width: number;
  height?: number;
  transform: number[];
}

export interface PdfViewportLike {
  transform: number[];
  clone?: (opts: { scale: number }) => PdfViewportLike;
}

/** 矩阵乘(2D 仿射,仿 pdf.js Util.transform) */
export function transformPoint(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** 归一化:TextItem -> 视口坐标 SimpleTextItem(scale=1) */
export function normalizeTextItem(item: PdfTextItemLike, viewport: PdfViewportLike): SimpleTextItem {
  const vp = viewport.clone ? viewport.clone({ scale: 1 }) : viewport;
  const m = transformPoint(vp.transform, item.transform);
  const x = m[4];
  const h = Math.max(Math.hypot(m[2], m[3]), item.height || 0);
  // PDF.js places m[5] on the text baseline. The rest of the pipeline uses
  // top-left rectangles (canvas/PDF viewport coordinates), so retain the
  // whole glyph box instead of starting crops at the baseline.
  const y = m[5] - h;
  // PDF.js already reports TextItem.width in viewport-independent page units.
  // Applying the text/font matrix again scales it by the font size (often 9–15x)
  // and makes every column line look full-width. Only the viewport scale belongs
  // here; the cloned production viewport is normalized to scale=1.
  const viewportScale = Math.hypot(vp.transform[0], vp.transform[1]) || 1;
  const w = item.width * viewportScale || 0;
  const baselineLength = Math.hypot(m[0], m[1]);
  if (baselineLength && (Math.abs(m[1]) > 1e-8 || m[0] < 0)) {
    const dx = m[0] / baselineLength;
    const dy = m[1] / baselineLength;
    // As for horizontal runs, this is an em-box approximation rather than
    // font-specific ink bounds. Rotate both advance and ascent together.
    const geometry: TextRunGeometry = {
      x: m[4], y: m[5], advanceX: dx * w, advanceY: dy * w,
      ascentX: dy * h, ascentY: -dx * h,
    };
    return { str: item.str, ...textRunRect(geometry), geometry };
  }
  return { str: item.str, x, y, w, h };
}
