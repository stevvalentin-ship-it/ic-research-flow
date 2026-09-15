// ============================================================================
// parser/index.ts —— 论文解析器统一入口(当前阶段:单页解析)
// 后续 Sprint 1 扩展:图/表/公式区域检测、charRects、跨页块装配。
// ============================================================================
import { itemsToLines, type SimpleTextItem } from './lines';
import { classifyLines, detectLayoutMode } from './columns';
import { groupLinesToBlocks, type RawBlock } from './blocks';

export interface ParsePageResult {
  lines: ReturnType<typeof classifyLines>;
  blocks: RawBlock[];
  layoutMode: 'single' | 'double' | 'mixed';
}

export function parsePageItems(items: SimpleTextItem[], pageW: number, pageH: number): ParsePageResult {
  const lines = classifyLines(itemsToLines(items, pageW), pageW);
  const blocks = groupLinesToBlocks(lines, pageW, pageH);
  return { lines, blocks, layoutMode: detectLayoutMode(lines) };
}

export * from './lines';
export * from './columns';
export * from './blocks';
export * from './regions';
export * from './charRects';
export * from './pdfjsAdapter';
export * from './docBuilder';
