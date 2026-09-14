import type { Rect } from '../../types/models';
import type { ColumnKind } from './columns';

/** A spanning item separates the reading bands above and below it. */
export function readingBands<T extends { col: ColumnKind }>(
  items: readonly T[],
  rectOf: (item: T) => Rect,
): T[][] {
  const visual = [...items].sort((left, right) => {
    const a = rectOf(left);
    const b = rectOf(right);
    return a.y - b.y || a.x - b.x;
  });
  const bands: T[][] = [];
  for (const item of visual) {
    const band = bands.at(-1);
    if (!band || (band[0]!.col === 'full') !== (item.col === 'full')) bands.push([item]);
    else band.push(item);
  }
  return bands.map((band) => band.sort((left, right) => {
    const rank = (col: ColumnKind) => col === 'right' ? 1 : 0;
    const a = rectOf(left);
    const b = rectOf(right);
    return rank(left.col) - rank(right.col) || a.y - b.y || a.x - b.x;
  }));
}

export function readingOrder<T extends { col: ColumnKind }>(
  items: readonly T[],
  rectOf: (item: T) => Rect,
): T[] {
  return readingBands(items, rectOf).flat();
}
