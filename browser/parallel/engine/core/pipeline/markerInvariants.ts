import type {
  TranslationBlockRequest,
  TranslationBlockResponse,
} from '../translate/protocol';

export interface MarkerInvariantIssue {
  stage: 'post-translation-block' | 'pre-typst';
  code:
    | 'local-structural.translation-block-mismatch'
    | 'local-structural.empty-target-segment'
    | 'local-structural.duplicate-target-marker'
    | 'local-structural.cross-block-marker-collision'
    | 'local-structural.marker-set-mismatch';
  entityId: string;
  firstSource?: string;
  conflictSource?: string;
  message: string;
  fingerprint: string;
}

function createIssue(value: Omit<MarkerInvariantIssue, 'fingerprint'>): MarkerInvariantIssue {
  return {
    ...value,
    fingerprint: [value.stage, value.code, value.entityId, value.firstSource ?? '', value.conflictSource ?? '']
      .join('|').toLocaleLowerCase(),
  };
}

export function targetMarkerIdsForResponse(
  request: TranslationBlockRequest,
  response: TranslationBlockResponse,
): string[] {
  if (request.alignmentMode === 'paragraph-fallback') return [`${request.blockId}-t-1`];
  return response.alignmentGroups.flatMap((group, groupIndex) => (
    group.targetSegments.map((_segment, segmentIndex) => (
      `${request.blockId}-g-${groupIndex + 1}-t-${segmentIndex + 1}`
    ))
  ));
}

export function validateTranslationBlockMarkers(input: {
  request: TranslationBlockRequest;
  response: TranslationBlockResponse;
  committedMarkerIds?: ReadonlySet<string>;
}): { markerIds: string[]; issues: MarkerInvariantIssue[] } {
  const issues: MarkerInvariantIssue[] = [];
  if (input.response.blockId !== input.request.blockId) {
    issues.push(createIssue({
      stage: 'post-translation-block', code: 'local-structural.translation-block-mismatch',
      entityId: input.response.blockId, firstSource: input.request.blockId,
      message: `翻译响应块 ${input.response.blockId} 与请求 ${input.request.blockId} 不一致`,
    }));
  }
  input.response.alignmentGroups.forEach((group, groupIndex) => {
    group.targetSegments.forEach((segment, segmentIndex) => {
      if (segment.trim()) return;
      issues.push(createIssue({
        stage: 'post-translation-block', code: 'local-structural.empty-target-segment',
        entityId: `${input.request.blockId}:${groupIndex}:${segmentIndex}`,
        message: `翻译块 ${input.request.blockId} 含空目标片段`,
      }));
    });
  });
  const markerIds = targetMarkerIdsForResponse(input.request, input.response);
  const seen = new Set<string>();
  for (const markerId of markerIds) {
    if (seen.has(markerId)) {
      issues.push(createIssue({
        stage: 'post-translation-block', code: 'local-structural.duplicate-target-marker',
        entityId: markerId, firstSource: input.request.blockId, conflictSource: input.request.blockId,
        message: `翻译块内目标 marker 重复：${markerId}`,
      }));
    }
    if (input.committedMarkerIds?.has(markerId)) {
      issues.push(createIssue({
        stage: 'post-translation-block', code: 'local-structural.cross-block-marker-collision',
        entityId: markerId, conflictSource: input.request.blockId,
        message: `目标 marker 与已验证翻译块冲突：${markerId}`,
      }));
    }
    seen.add(markerId);
  }
  return { markerIds, issues };
}

export function validateGlobalMarkers(input: {
  requiredMarkerIds: readonly string[];
  emittedMarkerIds: readonly string[];
}): MarkerInvariantIssue[] {
  const issues: MarkerInvariantIssue[] = [];
  const duplicate = (ids: readonly string[], source: string): void => {
    const seen = new Set<string>();
    ids.forEach((id) => {
      if (seen.has(id)) {
        issues.push(createIssue({
          stage: 'pre-typst', code: 'local-structural.duplicate-target-marker', entityId: id,
          firstSource: source, conflictSource: source, message: `全局目标 marker 重复：${id}`,
        }));
      }
      seen.add(id);
    });
  };
  duplicate(input.requiredMarkerIds, 'required');
  duplicate(input.emittedMarkerIds, 'emitted');
  const required = new Set(input.requiredMarkerIds);
  const emitted = new Set(input.emittedMarkerIds);
  for (const id of new Set([...required, ...emitted])) {
    if (required.has(id) === emitted.has(id)) continue;
    issues.push(createIssue({
      stage: 'pre-typst', code: 'local-structural.marker-set-mismatch', entityId: id,
      firstSource: required.has(id) ? 'required' : undefined,
      conflictSource: emitted.has(id) ? 'emitted' : undefined,
      message: `Typst marker 集合不一致：${id}`,
    }));
  }
  return issues;
}

export class MarkerInvariantError extends Error {
  readonly issues: MarkerInvariantIssue[];

  constructor(issues: readonly MarkerInvariantIssue[]) {
    super(`Marker 门禁未通过：${issues.map((item) => `${item.code}(${item.entityId})`).join('；')}`);
    this.name = 'MarkerInvariantError';
    this.issues = [...issues];
  }
}
