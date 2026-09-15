import type { Block, LayoutRegion, SemanticUnit } from '../../types/models';

/** Recover physical paragraph continuations without changing translation IDs. */
export function paragraphFlowGroups(
  units: readonly SemanticUnit[],
  regions: readonly LayoutRegion[],
  blocks: readonly Block[],
): Map<string, string> {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const result = new Map<string, string>();
  let previous: { unit: SemanticUnit; block: Block; flow: string } | undefined;
  for (const id of regions.flatMap((region) => region.orderedUnitIds)) {
    const unit = byId.get(id);
    const block = unit?.sourceBlockId ? blockById.get(unit.sourceBlockId) : undefined;
    if (!unit || !block || (unit.kind !== 'paragraph'
      && !(unit.kind === 'formula' && unit.id.includes('-inline-')))) {
      previous = undefined;
      continue;
    }
    let flow = unit.id;
    if (previous) {
      const left = previous.block;
      const gap = block.rect.y - left.rect.y - left.rect.h;
      const firstChar = block.characterRects?.find((char) => char.sourceIndex === 0);
      const firstX = firstChar?.rect.x ?? block.rect.x;
      const followsLine = left.pageIndex === block.pageIndex && gap >= -2 && gap <= 7
        && Math.abs(block.rect.x - left.rect.x) < 4
        && firstX <= block.rect.x + 4 && left.rect.w > block.rect.w * 0.75;
      if (left.id === block.id || followsLine) flow = previous.flow;
    }
    result.set(unit.id, flow);
    previous = { unit, block, flow };
  }
  return result;
}
