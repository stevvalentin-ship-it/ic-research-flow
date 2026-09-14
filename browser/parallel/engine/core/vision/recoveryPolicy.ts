import type { VisionReconciliationReason, VisionReconciliationResult } from './reconcile';
import { withRecomputedPlanVersion, type VisionPagePlan } from './pagePlan';
import type { VisionPlanValidationIssue } from './planVerifier';

const VISION_CORRECTABLE = new Set<VisionReconciliationReason>([
  'caption-unmatched',
  'caption-overlap',
  'foreign-caption-overlap',
  'page-edge-touch',
  'page-coverage-excessive',
]);

const LOCALLY_REJECTABLE = new Set<VisionReconciliationReason>([
  'body-prose-density',
  'implausible-formula-cluster',
]);

export function isVisionCorrectableReason(reason: VisionReconciliationReason): boolean {
  return VISION_CORRECTABLE.has(reason);
}

/** A newly exposed defect can follow a real repair of the first reported defect. */
export function hasSubstantiveVisionCorrectionProgress(
  before: readonly VisionPlanValidationIssue[],
  after: readonly VisionPlanValidationIssue[],
): boolean {
  if (after.length < before.length) return true;
  if (after.length > before.length || !before.length) return false;
  const identity = (issue: VisionPlanValidationIssue) => JSON.stringify([
    issue.pageIndex, issue.regionId ?? null, issue.code,
  ]);
  const remaining = new Set(after.map(identity));
  // Geometry jitter changes a fingerprint but does not resolve the defect.
  return before.some((issue) => !remaining.has(identity(issue)));
}

export function reconciliationValidationIssues(
  plans: ReadonlyMap<number, VisionPagePlan>,
  reconciliation: VisionReconciliationResult,
): VisionPlanValidationIssue[] {
  return reconciliation.unresolved.flatMap((unresolved) => {
    const plan = plans.get(unresolved.pageIndex);
    const region = unresolved.regionId
      ? plan?.regions.find((candidate) => candidate.id === unresolved.regionId)
      : plan?.regions[unresolved.regionIndex];
    if (!region) return [];
    const allowedFields: VisionPlanValidationIssue['allowedFields'] = unresolved.reason === 'caption-unmatched'
      || unresolved.reason === 'caption-overlap'
      ? ['bbox', 'captionBBox', 'captionLink']
      : VISION_CORRECTABLE.has(unresolved.reason)
        ? ['bbox']
        : [];
    return [{
      stage: 'source-plan' as const,
      code: `source-plan.${unresolved.reason}`,
      severity: 'error' as const,
      pageIndex: unresolved.pageIndex,
      regionId: region.id,
      reason: unresolved.reason === 'caption-overlap'
        ? '资产框与标题框相交；资产 bbox 必须排除标题文字并与 captionBBox 零相交'
        : unresolved.reason === 'foreign-caption-overlap'
          ? '资产框包含其他图表的标题；缩小或移动 bbox 以排除不属于本区域的可见标题'
        : unresolved.reason === 'caption-unmatched'
          ? 'captionBBox 未匹配到 PDF 文字层中的可见标题；不得虚构标题或标题框'
          : `区域未通过本地几何门：${unresolved.reason}`,
      actual: region.bbox.join(','),
      threshold: unresolved.reason === 'caption-overlap' ? 'bbox ∩ captionBBox = 0' : unresolved.reason,
      allowedFields,
      fingerprint: [
        unresolved.pageIndex,
        unresolved.reason,
        region.id,
        ...region.bbox.map((value) => Math.round(value / 10) * 10),
      ].join('|'),
    }];
  });
}

/** Removes only locally proven false positives; correctable errors must go through a patch. */
export function recoverLocallyRejectedRegions(
  plan: VisionPagePlan,
  reconciliation: VisionReconciliationResult,
): VisionPagePlan {
  const rejected = reconciliation.unresolved.filter((item) => (
    item.pageIndex === plan.pageIndex && LOCALLY_REJECTABLE.has(item.reason)
  ));
  if (!rejected.length) return plan;
  const rejectedIds = new Set(rejected.flatMap((item) => (
    item.regionId ? [item.regionId] : [plan.regions[item.regionIndex]?.id].filter(Boolean) as string[]
  )));
  return withRecomputedPlanVersion({
    ...plan,
    basePlanVersion: plan.planVersion,
    regions: plan.regions.filter((region) => !rejectedIds.has(region.id)),
    recoveryActions: [
      ...plan.recoveryActions,
      ...rejected.flatMap((item) => {
        const regionId = item.regionId ?? plan.regions[item.regionIndex]?.id;
        return regionId ? [{
          type: 'remove-rejected-region' as const,
          regionId,
          reason: item.reason,
        }] : [];
      }),
    ],
  });
}
