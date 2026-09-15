// ============================================================================
// layout.ts —— 分页结果 -> 布局描述(纯数据,与 DOM 无关)
// Vue 渲染器 / 打印导出 / 审计都消费这份布局描述。
// 算法基准:P9 探针(浏览器实测 dom=data、无越界 AUDIT=PASS)
// ============================================================================
import type { PaginatorResult } from './index';

export interface LayoutPlacement {
  pageIndex: number;
  pageMode: 'single' | 'double' | 'mixed';
  col: 'single' | 'full' | 'left' | 'right' | 'span';
  blockId: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  caption?: string;
  label?: string;
  fontSize?: number;
  scaled: boolean;
}

export interface LayoutPage {
  pageIndex: number;
  mode: 'single' | 'double' | 'mixed';
  placements: LayoutPlacement[];
}

export function buildLayout(result: PaginatorResult): LayoutPage[] {
  const g = result.geom;
  return result.pages.map((page, pi) => {
    const placements: LayoutPlacement[] = [];
    const cols: Array<{ name: 'single' | 'full' | 'left' | 'right'; x: number; w: number }> =
      page.mode === 'single'
        ? [{ name: 'single', x: g.margin, w: g.usableW }]
        : [
            { name: 'full', x: g.margin, w: g.usableW },
            { name: 'left', x: g.margin, w: g.colW },
            { name: 'right', x: g.margin + g.colW + g.gutter, w: g.colW },
          ];
    for (const col of cols) {
      for (const it of page[col.name].blocks) {
        placements.push({
          pageIndex: pi,
          pageMode: page.mode,
          col: col.name,
          blockId: it.block.id,
          type: it.block.type,
          x: col.x,
          y: it.y,
          w: col.w,
          h: it.h,
          text: it.block.text,
          caption: it.block.caption,
          label: it.block.label,
          fontSize: it.block.fontSize,
          scaled: it.h >= g.usableH - 1,
        });
      }
    }
    for (const it of page.spans) {
      placements.push({
        pageIndex: pi,
        pageMode: page.mode,
        col: 'span',
        blockId: it.block.id,
        type: it.block.type,
        x: g.margin,
        y: it.y,
        w: g.usableW,
        h: it.h,
        caption: it.block.caption,
        label: it.block.label,
        scaled: it.h >= g.usableH - 1,
      });
    }
    return { pageIndex: pi, mode: page.mode, placements };
  });
}

export interface LayoutIssue {
  pageIndex: number;
  col: LayoutPlacement['col'];
  blockId: string;
  overflowPx: number;
}

/** 布局审计:所有块不得越出页底;placements 数量必须与分页日志一致 */
export function auditLayout(result: PaginatorResult, layout: LayoutPage[]): LayoutIssue[] {
  const g = result.geom;
  const bottom = g.margin + g.usableH;
  const issues: LayoutIssue[] = [];
  for (const page of layout) {
    for (const p of page.placements) {
      if (p.y + p.h > bottom + 0.5) {
        issues.push({ pageIndex: page.pageIndex, col: p.col, blockId: p.blockId, overflowPx: p.y + p.h - bottom });
      }
    }
  }
  const placements = layout.reduce((n, p) => n + p.placements.length, 0);
  if (placements !== result.log.length) {
    issues.push({ pageIndex: -1, col: 'span', blockId: 'count-mismatch', overflowPx: placements - result.log.length });
  }
  return issues;
}
