import { parseNormalizedVisionBox } from './protocol';
import type {
  NormalizedVisionBox,
  VisionColumn,
  VisionCrossPageHint,
  VisionPageAnalysis,
  VisionRegionType,
} from './protocol';

export const VISION_PAGE_PLAN_SCHEMA_VERSION = 1 as const;
export const VISION_PLAN_CANONICALIZATION_VERSION = 'vision-plan-c14n-v2';

export type VisionPlanOrigin = 'initial' | 'correction-1' | 'correction-2';
export type VisionCaptionPosition = 'above' | 'below' | 'none' | 'unknown';

export interface VisionTextAnchor {
  blockId: string;
  textDigest: string;
  edge: 'before' | 'after';
}

export interface VisionOrderCandidate {
  beforeRegionId: string;
  afterRegionId: string;
  confidence: number;
  evidence: string;
}

export interface VisionPlanRegion {
  /** Local plan ID. Model-provided temporary IDs are never used as semantic IDs. */
  id: string;
  modelTemporaryId?: string;
  type: VisionRegionType;
  bbox: NormalizedVisionBox;
  column: VisionColumn;
  captionBBox?: NormalizedVisionBox;
  visibleLabel?: string;
  captionPosition: VisionCaptionPosition;
  crossPageHint?: VisionCrossPageHint;
  beforeAnchor?: VisionTextAnchor;
  afterAnchor?: VisionTextAnchor;
  confidence: number;
  evidence: string;
  locked: boolean;
}

export interface VisionPagePlan {
  schemaVersion: typeof VISION_PAGE_PLAN_SCHEMA_VERSION;
  canonicalizationVersion: typeof VISION_PLAN_CANONICALIZATION_VERSION;
  pageIndex: number;
  layout: VisionPageAnalysis['layout'];
  planVersion: string;
  basePlanVersion?: string;
  renderFingerprint: string;
  renderScale: number;
  origin: VisionPlanOrigin;
  regions: VisionPlanRegion[];
  orderCandidates: VisionOrderCandidate[];
  recoveryActions: Array<{ type: 'remove-rejected-region' | 'geometry-snap'; regionId: string; reason: string }>;
  appliedPatchIds: string[];
  planDigest: string;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function quantizedBox(box: NormalizedVisionBox): NormalizedVisionBox {
  return box.map((value) => Math.round(value * 10) / 10) as NormalizedVisionBox;
}

function regionAnchor(region: Pick<VisionPlanRegion, 'type' | 'bbox' | 'visibleLabel'>): string {
  return [region.type, region.visibleLabel?.trim().toLocaleLowerCase() ?? '', ...quantizedBox(region.bbox)]
    .join('|');
}

export function allocateVisionPlanRegionId(
  pageIndex: number,
  region: Pick<VisionPlanRegion, 'type' | 'bbox' | 'visibleLabel'>,
  existingIds: ReadonlySet<string> = new Set(),
): string {
  const anchor = regionAnchor(region);
  const base = `vp-p${pageIndex + 1}-${region.type.replace('display_', '')}-${fnv1a(anchor)}`;
  if (!existingIds.has(base)) return base;
  let collision = 2;
  while (existingIds.has(`${base}-${collision}`)) collision += 1;
  return `${base}-${collision}`;
}

function stableRegionIds(
  pageIndex: number,
  regions: readonly Omit<VisionPlanRegion, 'id'>[],
): VisionPlanRegion[] {
  const existingIds = new Set<string>();
  return regions.map((region) => {
    const id = allocateVisionPlanRegionId(pageIndex, region, existingIds);
    existingIds.add(id);
    return { ...region, id };
  });
}

export function createVisionPagePlan(input: {
  analysis: VisionPageAnalysis;
  renderFingerprint: string;
  renderScale?: number;
  origin?: VisionPlanOrigin;
}): VisionPagePlan {
  const regions = stableRegionIds(input.analysis.pageIndex, input.analysis.regions.map((region) => {
    // An equation number belongs inside the immutable formula crop; it is not
    // a separately translated caption. Vision providers regularly report it
    // as caption_bbox, which otherwise creates a permanent unmatched-caption
    // correction loop.
    const captionBBox = region.type === 'display_formula' ? undefined : region.captionBBox;
    return {
      modelTemporaryId: region.temporaryId,
      type: region.type,
      bbox: [...region.bbox] as NormalizedVisionBox,
      column: region.column,
      ...(captionBBox ? { captionBBox: [...captionBBox] as NormalizedVisionBox } : {}),
      visibleLabel: region.visibleLabel,
      captionPosition: region.type === 'display_formula'
        ? 'none' as const
        : region.captionPosition ?? (captionBBox ? 'unknown' : 'none'),
      crossPageHint: region.crossPageHint,
      confidence: region.confidence,
      evidence: region.evidence ?? '',
      locked: false,
    };
  }));
  const draft: Omit<VisionPagePlan, 'planDigest' | 'planVersion'> = {
    schemaVersion: VISION_PAGE_PLAN_SCHEMA_VERSION,
    canonicalizationVersion: VISION_PLAN_CANONICALIZATION_VERSION,
    pageIndex: input.analysis.pageIndex,
    layout: input.analysis.layout,
    renderFingerprint: input.renderFingerprint,
    renderScale: input.renderScale ?? 2,
    origin: input.origin ?? 'initial',
    regions,
    orderCandidates: [],
    recoveryActions: [],
    appliedPatchIds: [],
  };
  const planDigest = digestVisionPagePlan(draft);
  return { ...draft, planDigest, planVersion: `plan-${versionVisionPagePlan(draft)}` };
}

function normalizedPlanValue(
  plan: Omit<VisionPagePlan, 'planDigest' | 'planVersion'> | VisionPagePlan,
): unknown {
  return {
    schemaVersion: plan.schemaVersion,
    canonicalizationVersion: plan.canonicalizationVersion,
    pageIndex: plan.pageIndex,
    layout: plan.layout,
    regions: [...plan.regions]
      .map((region) => ({
        id: region.id,
        type: region.type,
        bbox: quantizedBox(region.bbox),
        column: region.column,
        captionBBox: region.captionBBox ? quantizedBox(region.captionBBox) : undefined,
        visibleLabel: region.visibleLabel?.trim() || undefined,
        captionPosition: region.captionPosition,
        crossPageHint: region.crossPageHint,
        beforeAnchor: region.beforeAnchor,
        afterAnchor: region.afterAnchor,
        confidence: Math.round(region.confidence * 100) / 100,
      }))
      .sort((left, right) => (
        left.type.localeCompare(right.type)
        || left.bbox[1] - right.bbox[1]
        || left.bbox[0] - right.bbox[0]
        || left.id.localeCompare(right.id)
      )),
    orderCandidates: [...plan.orderCandidates]
      .map((edge) => ({
        ...edge,
        confidence: Math.round(edge.confidence * 100) / 100,
      }))
      .sort((left, right) => (
        left.beforeRegionId.localeCompare(right.beforeRegionId)
        || left.afterRegionId.localeCompare(right.afterRegionId)
      )),
    recoveryActions: [...plan.recoveryActions]
      .map((action) => ({ ...action }))
      .sort((left, right) => left.regionId.localeCompare(right.regionId) || left.type.localeCompare(right.type)),
  };
}

export function digestVisionPagePlan(
  plan: Omit<VisionPagePlan, 'planDigest' | 'planVersion'> | VisionPagePlan,
): string {
  return fnv1a(JSON.stringify(normalizedPlanValue(plan)));
}

function versionVisionPagePlan(
  plan: Omit<VisionPagePlan, 'planDigest' | 'planVersion'> | VisionPagePlan,
): string {
  return fnv1a(JSON.stringify({
    structural: normalizedPlanValue(plan),
    renderFingerprint: plan.renderFingerprint,
    renderScale: plan.renderScale,
    origin: plan.origin,
    basePlanVersion: plan.basePlanVersion,
    locks: [...plan.regions].map((region) => [region.id, region.locked]).sort(),
    regionEvidence: [...plan.regions]
      .map((region) => [region.id, region.modelTemporaryId ?? '', region.evidence.trim()])
      .sort(),
    orderEvidence: [...plan.orderCandidates]
      .map((edge) => [edge.beforeRegionId, edge.afterRegionId, edge.evidence.trim()])
      .sort(),
    appliedPatchIds: [...plan.appliedPatchIds].sort(),
    recoveryActions: [...plan.recoveryActions]
      .map((action) => ({ ...action }))
      .sort((left, right) => left.regionId.localeCompare(right.regionId) || left.type.localeCompare(right.type)),
  }));
}

export function planToVisionAnalysis(plan: VisionPagePlan): VisionPageAnalysis {
  return {
    pageIndex: plan.pageIndex,
    layout: plan.layout,
    regions: plan.regions.map((region) => ({
      type: region.type,
      bbox: [...region.bbox] as NormalizedVisionBox,
      column: region.column,
      ...(region.captionBBox ? { captionBBox: [...region.captionBBox] as NormalizedVisionBox } : {}),
      confidence: region.confidence,
      temporaryId: region.modelTemporaryId,
      localId: region.id,
      visibleLabel: region.visibleLabel,
      captionPosition: region.captionPosition,
      crossPageHint: region.crossPageHint,
      evidence: region.evidence,
    })),
  };
}

export function withRecomputedPlanVersion(
  plan: Omit<VisionPagePlan, 'planDigest' | 'planVersion'>,
): VisionPagePlan {
  const planDigest = digestVisionPagePlan(plan);
  return { ...plan, planDigest, planVersion: `plan-${versionVisionPagePlan(plan)}` };
}

export function parseCachedVisionPagePlan(value: unknown, expectedPageIndex: number): VisionPagePlan {
  const object = cacheRecord(value, 'plan');
  cacheAllowedKeys(object, [
    'schemaVersion', 'canonicalizationVersion', 'pageIndex', 'layout', 'planVersion',
    'basePlanVersion', 'renderFingerprint', 'renderScale', 'origin', 'regions',
    'orderCandidates', 'recoveryActions', 'appliedPatchIds', 'planDigest',
  ], 'plan');
  if (object.schemaVersion !== VISION_PAGE_PLAN_SCHEMA_VERSION
    || object.canonicalizationVersion !== VISION_PLAN_CANONICALIZATION_VERSION
    || object.pageIndex !== expectedPageIndex) {
    throw new Error('缓存页面计划版本或页面无效');
  }
  if (!Array.isArray(object.regions) || object.regions.length > 32
    || !Array.isArray(object.orderCandidates) || object.orderCandidates.length > 64
    || !Array.isArray(object.recoveryActions) || object.recoveryActions.length > 64
    || !Array.isArray(object.appliedPatchIds) || object.appliedPatchIds.length > 2) {
    throw new Error('缓存页面计划数组字段无效或超过上限');
  }
  const renderScale = cacheFiniteNumber(object.renderScale, 'plan.renderScale');
  if (renderScale <= 0 || renderScale > 8) throw new Error('缓存页面计划 renderScale 无效');
  const regions = object.regions.map((value, index): VisionPlanRegion => {
    const region = cacheRecord(value, `plan.regions[${index}]`);
    cacheAllowedKeys(region, [
      'id', 'modelTemporaryId', 'type', 'bbox', 'column', 'captionBBox', 'visibleLabel',
      'captionPosition', 'crossPageHint', 'beforeAnchor', 'afterAnchor', 'confidence',
      'evidence', 'locked',
    ], `plan.regions[${index}]`);
    const confidence = cacheFiniteNumber(region.confidence, `plan.regions[${index}].confidence`);
    if (confidence < 0 || confidence > 1) throw new Error(`缓存页面计划 regions[${index}].confidence 无效`);
    if (typeof region.locked !== 'boolean') throw new Error(`缓存页面计划 regions[${index}].locked 无效`);
    return {
      id: cacheText(region.id, `plan.regions[${index}].id`, 160),
      ...(region.modelTemporaryId === undefined ? {} : {
        modelTemporaryId: cacheText(region.modelTemporaryId, `plan.regions[${index}].modelTemporaryId`, 100),
      }),
      type: cacheEnum(region.type, ['figure', 'table', 'display_formula', 'code'] as const, `plan.regions[${index}].type`),
      bbox: parseNormalizedVisionBox(region.bbox, `plan.regions[${index}].bbox`),
      column: cacheEnum(region.column, ['left', 'right', 'full'] as const, `plan.regions[${index}].column`),
      ...(region.captionBBox === undefined ? {} : {
        captionBBox: parseNormalizedVisionBox(region.captionBBox, `plan.regions[${index}].captionBBox`),
      }),
      ...(region.visibleLabel === undefined ? {} : {
        visibleLabel: cacheText(region.visibleLabel, `plan.regions[${index}].visibleLabel`, 100),
      }),
      captionPosition: cacheEnum(
        region.captionPosition,
        ['above', 'below', 'none', 'unknown'] as const,
        `plan.regions[${index}].captionPosition`,
      ),
      ...(region.crossPageHint === undefined ? {} : {
        crossPageHint: cacheEnum(
          region.crossPageHint,
          ['none', 'starts', 'continues', 'ends', 'unknown'] as const,
          `plan.regions[${index}].crossPageHint`,
        ),
      }),
      ...(region.beforeAnchor === undefined ? {} : {
        beforeAnchor: parseCachedTextAnchor(region.beforeAnchor, `plan.regions[${index}].beforeAnchor`),
      }),
      ...(region.afterAnchor === undefined ? {} : {
        afterAnchor: parseCachedTextAnchor(region.afterAnchor, `plan.regions[${index}].afterAnchor`),
      }),
      confidence,
      evidence: cacheText(region.evidence, `plan.regions[${index}].evidence`, 240, true),
      locked: region.locked,
    };
  });
  const orderCandidates = object.orderCandidates.map((value, index): VisionOrderCandidate => {
    const edge = cacheRecord(value, `plan.orderCandidates[${index}]`);
    cacheAllowedKeys(edge, ['beforeRegionId', 'afterRegionId', 'confidence', 'evidence'], `plan.orderCandidates[${index}]`);
    const confidence = cacheFiniteNumber(edge.confidence, `plan.orderCandidates[${index}].confidence`);
    if (confidence < 0 || confidence > 1) throw new Error(`缓存页面计划 orderCandidates[${index}].confidence 无效`);
    return {
      beforeRegionId: cacheText(edge.beforeRegionId, `plan.orderCandidates[${index}].beforeRegionId`, 160),
      afterRegionId: cacheText(edge.afterRegionId, `plan.orderCandidates[${index}].afterRegionId`, 160),
      confidence,
      evidence: cacheText(edge.evidence, `plan.orderCandidates[${index}].evidence`, 240, true),
    };
  });
  const recoveryActions = object.recoveryActions.map((value, index): VisionPagePlan['recoveryActions'][number] => {
    const action = cacheRecord(value, `plan.recoveryActions[${index}]`);
    cacheAllowedKeys(action, ['type', 'regionId', 'reason'], `plan.recoveryActions[${index}]`);
    return {
      type: cacheEnum(action.type, ['remove-rejected-region', 'geometry-snap'] as const, `plan.recoveryActions[${index}].type`),
      regionId: cacheText(action.regionId, `plan.recoveryActions[${index}].regionId`, 160),
      reason: cacheText(action.reason, `plan.recoveryActions[${index}].reason`, 240),
    };
  });
  const appliedPatchIds = object.appliedPatchIds.map((id, index) => (
    cacheText(id, `plan.appliedPatchIds[${index}]`, 160)
  ));
  const candidate: VisionPagePlan = {
    schemaVersion: VISION_PAGE_PLAN_SCHEMA_VERSION,
    canonicalizationVersion: VISION_PLAN_CANONICALIZATION_VERSION,
    pageIndex: expectedPageIndex,
    layout: cacheEnum(object.layout, ['single', 'double', 'mixed'] as const, 'plan.layout'),
    planVersion: cacheText(object.planVersion, 'plan.planVersion', 160),
    ...(object.basePlanVersion === undefined ? {} : {
      basePlanVersion: cacheText(object.basePlanVersion, 'plan.basePlanVersion', 160),
    }),
    renderFingerprint: cacheText(object.renderFingerprint, 'plan.renderFingerprint', 240),
    renderScale,
    origin: cacheEnum(object.origin, ['initial', 'correction-1', 'correction-2'] as const, 'plan.origin'),
    regions,
    orderCandidates,
    recoveryActions,
    appliedPatchIds,
    planDigest: cacheText(object.planDigest, 'plan.planDigest', 160),
  };
  if (digestVisionPagePlan(candidate) !== candidate.planDigest
    || candidate.planVersion !== `plan-${versionVisionPagePlan(candidate)}`) {
    throw new Error('缓存页面计划摘要不一致');
  }
  return candidate;
}

function cacheRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`缓存页面计划 ${path} 必须为对象`);
  return value as Record<string, unknown>;
}

function cacheAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allow.has(key));
  if (unknown) throw new Error(`缓存页面计划 ${path} 包含未知字段 ${unknown}`);
}

function cacheText(value: unknown, path: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxLength) {
    throw new Error(`缓存页面计划 ${path} 字符串无效`);
  }
  return value;
}

function cacheFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`缓存页面计划 ${path} 数值无效`);
  return value;
}

function cacheEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`缓存页面计划 ${path} 枚举无效`);
  return value as T;
}

function parseCachedTextAnchor(value: unknown, path: string): VisionTextAnchor {
  const anchor = cacheRecord(value, path);
  cacheAllowedKeys(anchor, ['blockId', 'textDigest', 'edge'], path);
  return {
    blockId: cacheText(anchor.blockId, `${path}.blockId`, 160),
    textDigest: cacheText(anchor.textDigest, `${path}.textDigest`, 160),
    edge: cacheEnum(anchor.edge, ['before', 'after'] as const, `${path}.edge`),
  };
}
