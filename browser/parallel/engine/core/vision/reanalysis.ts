import type { CrossPageAssetGroup } from './crossPageRelations';

/** Expands failed pages to every member of a related cross-page asset group. */
export function expandVisionReanalysisPages(
  failedPages: readonly number[],
  groups: readonly CrossPageAssetGroup[],
): number[] {
  const affected = new Set(failedPages.filter((page) => Number.isInteger(page) && page >= 0));
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (!group.members.some((member) => affected.has(member.pageIndex))) continue;
      for (const member of group.members) {
        if (!affected.has(member.pageIndex)) {
          affected.add(member.pageIndex);
          changed = true;
        }
      }
    }
  }
  return [...affected].sort((left, right) => left - right);
}
