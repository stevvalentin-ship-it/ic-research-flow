import type { NormalizedVisionBox } from './protocol';
import type { VisionPagePlan } from './pagePlan';

export type VisionPlanIssueSeverity = 'warning' | 'error';

export interface VisionPlanValidationIssue {
  stage: 'source-plan';
  code: `source-plan.${string}`;
  severity: VisionPlanIssueSeverity;
  pageIndex: number;
  regionId?: string;
  reason: string;
  actual?: number | string;
  threshold?: number | string;
  allowedFields: Array<'regions' | 'bbox' | 'captionBBox' | 'column' | 'captionLink' | 'orderCandidates'>;
  fingerprint: string;
}

function fingerprint(parts: readonly (string | number | undefined)[]): string {
  return parts.map((part) => String(part ?? '')).join('|').toLocaleLowerCase();
}

function validBox(box: NormalizedVisionBox): boolean {
  const [x, y, w, h] = box;
  return box.length === 4
    && box.every(Number.isFinite)
    && x >= 0 && y >= 0 && w > 0 && h > 0
    && x + w <= 1000 && y + h <= 1000;
}

function hasOrderCycle(plan: VisionPagePlan): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of plan.orderCandidates) {
    const edges = outgoing.get(edge.beforeRegionId) ?? [];
    edges.push(edge.afterRegionId);
    outgoing.set(edge.beforeRegionId, edges);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((outgoing.get(id) ?? []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return plan.regions.some((region) => visit(region.id));
}

/** Pure protocol-level verification. It never mutates or repairs the page plan. */
export function verifyVisionPagePlan(plan: VisionPagePlan): VisionPlanValidationIssue[] {
  const issues: VisionPlanValidationIssue[] = [];
  const ids = new Set<string>();
  const supportedRegionTypes = new Set(['figure', 'table', 'display_formula', 'code']);
  for (const region of plan.regions) {
    if (ids.has(region.id)) {
      issues.push({
        stage: 'source-plan', code: 'source-plan.duplicate-region-id', severity: 'error',
        pageIndex: plan.pageIndex, regionId: region.id, reason: '视觉区域 ID 重复',
        allowedFields: [], fingerprint: fingerprint([plan.pageIndex, 'duplicate-region-id', region.id]),
      });
    }
    ids.add(region.id);
    if (!supportedRegionTypes.has(region.type)) {
      issues.push({
        stage: 'source-plan', code: 'source-plan.unsupported-region-type', severity: 'error',
        pageIndex: plan.pageIndex, regionId: region.id, reason: '视觉页面计划包含非不可变资产区域',
        actual: region.type, threshold: 'figure|table|display_formula|code',
        allowedFields: [], fingerprint: fingerprint([plan.pageIndex, 'unsupported-region-type', region.id, region.type]),
      });
    }
    if (!validBox(region.bbox)) {
      issues.push({
        stage: 'source-plan', code: 'source-plan.invalid-bbox', severity: 'error',
        pageIndex: plan.pageIndex, regionId: region.id, reason: '资产区域超出规范化页面范围',
        actual: region.bbox.join(','), threshold: '0..1000 xywh', allowedFields: ['bbox'],
        fingerprint: fingerprint([plan.pageIndex, 'invalid-bbox', region.id, ...region.bbox.map(Math.round)]),
      });
    }
    if (region.captionBBox && !validBox(region.captionBBox)) {
      issues.push({
        stage: 'source-plan', code: 'source-plan.caption-outside-page', severity: 'error',
        pageIndex: plan.pageIndex, regionId: region.id, reason: '标题区域超出规范化页面范围',
        actual: region.captionBBox.join(','), threshold: '0..1000 xywh', allowedFields: ['captionBBox'],
        fingerprint: fingerprint([plan.pageIndex, 'caption-outside-page', region.id]),
      });
    }
  }
  for (const edge of plan.orderCandidates) {
    if (edge.beforeRegionId === edge.afterRegionId) {
      issues.push({
        stage: 'source-plan', code: 'source-plan.self-order-edge', severity: 'error',
        pageIndex: plan.pageIndex, regionId: edge.beforeRegionId, reason: '阅读顺序候选不能指向自身',
        allowedFields: ['orderCandidates'],
        fingerprint: fingerprint([plan.pageIndex, 'self-order-edge', edge.beforeRegionId]),
      });
    }
    for (const id of [edge.beforeRegionId, edge.afterRegionId]) {
      if (ids.has(id)) continue;
      issues.push({
        stage: 'source-plan', code: 'source-plan.unknown-order-region', severity: 'error',
        pageIndex: plan.pageIndex, regionId: id, reason: '阅读顺序候选引用未知区域',
        allowedFields: ['orderCandidates'],
        fingerprint: fingerprint([plan.pageIndex, 'unknown-order-region', id]),
      });
    }
  }
  if (hasOrderCycle(plan)) {
    issues.push({
      stage: 'source-plan', code: 'source-plan.order-cycle', severity: 'error',
      pageIndex: plan.pageIndex, reason: '阅读顺序候选形成循环', allowedFields: ['orderCandidates'],
      fingerprint: fingerprint([plan.pageIndex, 'order-cycle']),
    });
  }
  return issues.sort((left, right) => (
    left.code.localeCompare(right.code) || (left.regionId ?? '').localeCompare(right.regionId ?? '')
  ));
}
