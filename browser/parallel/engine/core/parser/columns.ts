// ============================================================================
// columns.ts —— 分栏分类与阅读顺序
// 算法基准:P4/P5 探针(已 debug)。纯函数、零依赖。
// ============================================================================
import type { ParsedLine } from './lines';
import { readingOrder } from './readingOrder';

export type ColumnKind = 'full' | 'left' | 'right';

export interface ClassifiedLine extends ParsedLine {
  col: ColumnKind;
}

/**
 * 每行分类:
 * - full :span > 0.5W、页面居中的前置信息,或摘要/关键词行
 * - right:行中点 > 0.5W
 * - left :其余
 */
export function classifyLines(lines: ParsedLine[], pageW: number): ClassifiedLine[] {
  const out: ClassifiedLine[] = lines.map((l) => {
    const span = l.x2 - l.x1;
    const mid = (l.x1 + l.x2) / 2;
    const nearCenter = Math.abs(mid - pageW / 2) <= pageW * 0.08;
    const authorLike = /[,，]|university|大学|学院|laboratory|\blab\b/i.test(l.text);
    const centeredFrontMatter = l.y < 180
      && nearCenter
      && (span > pageW * 0.28 || authorLike)
      && l.x1 > pageW * 0.18
      && l.x2 < pageW * 0.82;
    const namedFrontMatter = /^(abstract|摘要|key ?words|关键词)[\s—\-:：]/i.test(l.text.trim())
      && span > pageW * 0.45;
    let col: ColumnKind = 'left';
    if (span > pageW * 0.5 || centeredFrontMatter || namedFrontMatter) col = 'full';
    else if (mid > pageW * 0.5) col = 'right';
    return { ...l, col };
  });

  // Full-width prose often wraps to a much shorter final line. Preserve that
  // continuation when it shares the same left edge and normal line spacing.
  const byVisualY = [...out].sort((left, right) => left.y - right.y || left.x1 - right.x1);
  for (let index = 1; index < byVisualY.length; index += 1) {
    const current = byVisualY[index]!;
    const previous = byVisualY[index - 1]!;
    const baselineGap = current.y - previous.y;
    if (
      current.col !== 'full'
      && previous.col === 'full'
      && baselineGap > 0
      && baselineGap <= Math.max(current.h, previous.h) * 1.7
      && Math.abs(current.x1 - previous.x1) <= 12
      && !byVisualY.some((other) => (
        other !== current
        && other.col === (current.col === 'left' ? 'right' : 'left')
        && other.y < current.y + current.h
        && current.y < other.y + other.h
      ))
    ) current.col = 'full';
  }
  // Read both lanes above a spanning item before entering the next band.
  return readingOrder(out, (line) => ({ x: line.x1, y: line.y, w: line.x2 - line.x1, h: line.h }));
}

/** 页面分栏模式判定(供版式继承 R4 使用) */
export function detectLayoutMode(lines: ClassifiedLine[]): 'single' | 'double' | 'mixed' {
  const cols = new Set(lines.map((l) => l.col));
  // Full-width paragraphs and their short headings still form one column.
  // A mixed page needs evidence of both physical lanes as well as a span.
  const left = lines.filter((line) => line.col === 'left');
  const right = lines.filter((line) => line.col === 'right');
  const parallelLanes = left.some((a) => right.some((b) => a.y < b.y + b.h && b.y < a.y + a.h));
  if (!parallelLanes) return 'single';
  return cols.has('full') ? 'mixed' : 'double';
}
