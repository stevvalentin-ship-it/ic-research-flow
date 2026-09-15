import type { LayoutMode, LayoutRegion, Rect } from '../../types/models';
import type { ColumnKind } from '../parser/columns';

export interface LayoutRegionBlockInput {
  id: string;
  pageIndex: number;
  order: number;
  col: ColumnKind;
  rect: Rect;
}

export interface LayoutRegionInput {
  pageWidth: number;
  pageModes?: Record<number, LayoutMode>;
  blocks: readonly LayoutRegionBlockInput[];
}

type RegionMode = LayoutRegion['mode'];

function normalizedMode(block: LayoutRegionBlockInput, pageModes?: Record<number, LayoutMode>): RegionMode {
  if (pageModes?.[block.pageIndex] === 'single') return 'single';
  if (block.col === 'left' || block.col === 'right') return 'double';
  return 'full-width';
}

function unionBounds(left: Rect, right: Rect): Rect {
  const x1 = Math.min(left.x, right.x);
  const y1 = Math.min(left.y, right.y);
  const x2 = Math.max(left.x + left.w, right.x + right.w);
  const y2 = Math.max(left.y + left.h, right.y + right.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function buildLayoutRegions(input: LayoutRegionInput): LayoutRegion[] {
  const ordered = [...input.blocks].sort((left, right) => left.order - right.order);
  const pageGroups: LayoutRegion[] = [];

  for (const block of ordered) {
    const mode = normalizedMode(block, input.pageModes);
    const current = pageGroups.at(-1);
    if (!current || current.sourcePage !== block.pageIndex || current.mode !== mode) {
      pageGroups.push({
        id: `region-${pageGroups.length + 1}`,
        mode,
        sourcePage: block.pageIndex,
        bounds: { ...block.rect },
        orderedUnitIds: [block.id],
      });
      continue;
    }
    current.bounds = unionBounds(current.bounds, block.rect);
    current.orderedUnitIds.push(block.id);
  }

  return pageGroups;
}
