import type { AlignmentManifest } from '../align/manifest';
import type { TypstSemanticUnit, LayoutRepairPlan } from '../typst/project';
import { isBlockingVisionFinalIssue, type VisionFinalIssue } from '../vision/finalReview';

export interface PdfPageSize {
  width: number;
  height: number;
}

export interface BuildLayoutRepairPlanInput {
  attempt: 1 | 2;
  issues: readonly VisionFinalIssue[];
  manifest: AlignmentManifest;
  units: readonly TypstSemanticUnit[];
  pageSizes: ReadonlyMap<number, PdfPageSize>;
  previous?: LayoutRepairPlan;
}

const NON_REPAIRABLE = new Set<VisionFinalIssue['type']>([
  'asset_changed', 'asset_missing', 'formula_changed', 'table_changed',
  'missing_text', 'untranslated_body', 'unreadable_glyphs', 'review_incomplete',
]);

function issueFingerprint(issue: VisionFinalIssue): string {
  return [
    issue.targetPageIndex,
    issue.type,
    ...issue.bbox.map((value) => Math.round(value / 10) * 10),
    issue.evidence.trim().toLocaleLowerCase(),
  ].join('|');
}

function intersectionArea(
  left: { x: number; y: number; w: number; h: number },
  right: { x: number; y: number; w: number; h: number },
): number {
  return Math.max(0, Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x))
    * Math.max(0, Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y));
}

function mappedUnitId(
  issue: VisionFinalIssue,
  manifest: AlignmentManifest,
  units: readonly TypstSemanticUnit[],
  pageSizes: ReadonlyMap<number, PdfPageSize>,
): string | undefined {
  const page = pageSizes.get(issue.targetPageIndex);
  if (!page) return undefined;
  const issueRect = {
    x: issue.bbox[0] / 1000 * page.width,
    y: issue.bbox[1] / 1000 * page.height,
    w: issue.bbox[2] / 1000 * page.width,
    h: issue.bbox[3] / 1000 * page.height,
  };
  const unitIds = new Set(units.map((unit) => unit.id));
  const ranked = manifest.units.flatMap((alignment) => {
    const overlap = alignment.target
      .filter((set) => set.page === issue.targetPageIndex)
      .flatMap((set) => set.rects)
      .reduce((sum, rect) => sum + intersectionArea(issueRect, rect), 0);
    if (overlap <= 0) return [];
    const candidates = [alignment.sourceBlockId, alignment.parentId, alignment.id, ...alignment.sourceUnitIds]
      .filter((id): id is string => Boolean(id));
    const unitId = candidates.find((id) => unitIds.has(id));
    return unitId ? [{ unitId, overlap }] : [];
  }).sort((left, right) => right.overlap - left.overlap);
  return ranked[0]?.unitId;
}

export function buildLayoutRepairPlan(input: BuildLayoutRepairPlanInput): LayoutRepairPlan | undefined {
  // Content integrity is immutable. If even one blocking content issue is
  // present, do not spend later attempts moving or shrinking unrelated layout
  // units: that can hide the symptom but cannot restore missing/changing data.
  if (input.issues.some((issue) => (
    isBlockingVisionFinalIssue(issue) && NON_REPAIRABLE.has(issue.type)
  ))) return undefined;

  const previousFingerprints = new Set(input.previous?.issueFingerprints ?? []);
  const plan: LayoutRepairPlan = {
    attempt: input.attempt,
    extraHeadingBelowPt: { ...(input.previous?.extraHeadingBelowPt ?? {}) },
    forcePageBreakBeforeUnitIds: [...(input.previous?.forcePageBreakBeforeUnitIds ?? [])],
    assetScaleByUnitId: { ...(input.previous?.assetScaleByUnitId ?? {}) },
    stackAssetGroupIds: [...(input.previous?.stackAssetGroupIds ?? [])],
    issueFingerprints: [...previousFingerprints],
    actions: [],
  };
  const addUnique = (list: string[], value: string): void => {
    if (!list.includes(value)) list.push(value);
  };
  for (const issue of input.issues) {
    if (!isBlockingVisionFinalIssue(issue) || NON_REPAIRABLE.has(issue.type)) continue;
    if (issue.type === 'layout_drift'
      && /(?:scattered text|stray (?:text|punctuation)|author.*body|mixed\s+(?:with|into)\s+(?:the\s+)?body|作者单位.*正文混排|正文混排|散落文本|孤立标点)/i.test(issue.evidence)) continue;
    const fingerprint = issueFingerprint(issue);
    if (previousFingerprints.has(fingerprint)) continue;
    plan.issueFingerprints.push(fingerprint);
    const unitId = mappedUnitId(issue, input.manifest, input.units, input.pageSizes);
    const unit = input.units.find((candidate) => candidate.id === unitId);
    if (!unit) continue;
    if (unit.kind === 'heading') {
      if (/orphan|isolated|孤立|单独|页末/i.test(issue.evidence)) {
        addUnique(plan.forcePageBreakBeforeUnitIds, unit.id);
        plan.actions.push({ type: 'page-break', unitId: unit.id, detail: '标题与首段整体移到下一页' });
      } else {
        const below = Math.min(4, (plan.extraHeadingBelowPt[unit.id] ?? 0) + 2);
        plan.extraHeadingBelowPt[unit.id] = below;
        plan.actions.push({ type: 'heading-spacing', unitId: unit.id, detail: `标题段后距额外增加 ${below}pt` });
      }
      continue;
    }
    if (unit.assetId || ['figure', 'table', 'formula', 'code'].includes(unit.kind)) {
      const scale = Math.max(0.8, Number(((plan.assetScaleByUnitId[unit.id] ?? 1) * 0.92).toFixed(3)));
      plan.assetScaleByUnitId[unit.id] = scale;
      addUnique(plan.forcePageBreakBeforeUnitIds, unit.id);
      plan.actions.push({ type: 'asset-scale', unitId: unit.id, detail: `资产缩放至 ${Math.round(scale * 100)}% 并整体换页` });
      if (/side.by.side|grid|narrow|crowd|并排|过窄|拥挤/i.test(issue.evidence)) {
        addUnique(plan.stackAssetGroupIds, unit.layoutRegionId);
        plan.actions.push({ type: 'stack-assets', unitId: unit.layoutRegionId, detail: '并排资产改为纵向排列' });
      }
      continue;
    }
    if (issue.type === 'overlap' || issue.type === 'clipped_text' || issue.type === 'layout_drift') {
      addUnique(plan.forcePageBreakBeforeUnitIds, unit.id);
      plan.actions.push({ type: 'page-break', unitId: unit.id, detail: '文本单元整体移到下一页' });
    }
  }
  return plan.actions.length ? plan : undefined;
}
