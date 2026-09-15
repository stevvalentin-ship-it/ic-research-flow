import type { AlignmentRectSet, AlignmentUnit } from '../../types/models';
import type { TargetTextMatch } from './textFallback';

export interface AlignmentManifest {
  schemaVersion: 1;
  projectId: string;
  createdAt: number;
  units: AlignmentUnit[];
  stats: {
    total: number;
    aligned: number;
    lowConfidence: number;
    unmatched: number;
    coverage: number;
  };
}

export interface ParagraphFallbackGeometry {
  source: AlignmentRectSet[];
  target: AlignmentRectSet[];
  confidence: number;
  sourceText?: string;
  targetText?: string;
}

export interface AlignmentManifestInput {
  projectId: string;
  createdAt?: number;
  units: AlignmentUnit[];
  markers: Map<string, AlignmentRectSet[]>;
  fallback: Map<string, TargetTextMatch>;
  paragraphFallback?: Map<string, ParagraphFallbackGeometry>;
}

function mergeGeometry(parts: AlignmentRectSet[][]): AlignmentRectSet[] {
  const pages = new Map<number, AlignmentRectSet['rects']>();
  for (const part of parts) {
    for (const set of part) {
      const rects = pages.get(set.page) ?? [];
      rects.push(...set.rects.map((rect) => ({ ...rect })));
      pages.set(set.page, rects);
    }
  }
  return [...pages.entries()]
    .sort(([left], [right]) => left - right)
    .map(([page, rects]) => ({ page, rects }));
}

function statusForConfidence(confidence: number): AlignmentUnit['status'] {
  if (confidence >= 0.9) return 'aligned';
  if (confidence > 0) return 'low-confidence';
  return 'unmatched';
}

function hasGeometry(sets: AlignmentRectSet[]): boolean {
  return sets.some((set) => set.rects.length > 0);
}

function withTargetGeometry(
  unit: AlignmentUnit,
  target: AlignmentRectSet[],
  targetConfidence: number,
): AlignmentUnit {
  const sourceReady = hasGeometry(unit.source);
  const targetReady = hasGeometry(target);
  if (!sourceReady || !targetReady) {
    return {
      ...unit,
      target,
      confidence: 0,
      status: 'unmatched',
      fallbackReason: !sourceReady ? 'source-geometry-missing' : 'target-geometry-missing',
    };
  }
  const confidence = Math.min(unit.confidence || 1, targetConfidence);
  return {
    ...unit,
    target,
    confidence,
    status: statusForConfidence(confidence),
  };
}

function resolveTargetGeometry(
  unit: AlignmentUnit,
  markers: Map<string, AlignmentRectSet[]>,
  fallback: Map<string, TargetTextMatch>,
): AlignmentUnit {
  const markerParts = unit.targetUnitIds.map((id) => markers.get(id));
  if (markerParts.length > 0 && markerParts.every((part) => part && part.length > 0)) {
    return withTargetGeometry(unit, mergeGeometry(markerParts as AlignmentRectSet[][]), 1);
  }

  const fallbackParts = unit.targetUnitIds.map((id) => fallback.get(id));
  if (fallbackParts.length > 0 && fallbackParts.every((part) => part?.status === 'aligned')) {
    const matches = fallbackParts as TargetTextMatch[];
    const confidence = Math.min(...matches.map((match) => match.confidence));
    return withTargetGeometry(unit, mergeGeometry(matches.map((match) => match.rects)), confidence);
  }

  return withTargetGeometry(unit, [], 0);
}

function collapseParagraphFallbacks(
  units: AlignmentUnit[],
  fallbacks: Map<string, ParagraphFallbackGeometry>,
): AlignmentUnit[] {
  const childrenByParent = new Map<string, number[]>();
  units.forEach((unit, index) => {
    if (unit.kind !== 'semantic-group' || !unit.parentId) return;
    const indices = childrenByParent.get(unit.parentId) ?? [];
    indices.push(index);
    childrenByParent.set(unit.parentId, indices);
  });

  const replacements = new Map<number, AlignmentUnit>();
  const skipped = new Set<number>();
  for (const [parentId, indices] of childrenByParent) {
    if (!indices.some((index) => units[index].confidence < 0.9)) continue;
    const fallback = fallbacks.get(parentId);
    if (!fallback || fallback.confidence < 0.98 || !fallback.source.length || !fallback.target.length) continue;
    indices.forEach((index) => skipped.add(index));
    replacements.set(indices[0], {
      id: parentId,
      parentId,
      kind: 'block',
      relation: 'paragraph-fallback',
      sourceUnitIds: units.flatMap((unit, index) => indices.includes(index) ? unit.sourceUnitIds : []),
      targetUnitIds: units.flatMap((unit, index) => indices.includes(index) ? unit.targetUnitIds : []),
      sourceText: fallback.sourceText,
      targetText: fallback.targetText,
      source: fallback.source.map((set) => ({ page: set.page, rects: set.rects.map((rect) => ({ ...rect })) })),
      target: fallback.target.map((set) => ({ page: set.page, rects: set.rects.map((rect) => ({ ...rect })) })),
      confidence: fallback.confidence,
      status: 'aligned',
      fallbackReason: 'group-geometry-low-confidence',
      order: units[indices[0]].order,
    });
  }

  const output: AlignmentUnit[] = [];
  units.forEach((unit, index) => {
    const replacement = replacements.get(index);
    if (replacement) output.push(replacement);
    if (!skipped.has(index)) output.push(unit);
  });
  return output;
}

function statsFor(units: AlignmentUnit[]): AlignmentManifest['stats'] {
  const aligned = units.filter((unit) => unit.status === 'aligned').length;
  const lowConfidence = units.filter((unit) => unit.status === 'low-confidence').length;
  const unmatched = units.filter((unit) => unit.status === 'unmatched').length;
  const total = units.length;
  return {
    total,
    aligned,
    lowConfidence,
    unmatched,
    coverage: total === 0 ? 1 : (aligned + lowConfidence) / total,
  };
}

export function buildAlignmentManifest(input: AlignmentManifestInput): AlignmentManifest {
  const resolved = input.units.map((unit) => resolveTargetGeometry(unit, input.markers, input.fallback));
  const units = collapseParagraphFallbacks(resolved, input.paragraphFallback ?? new Map());
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    createdAt: input.createdAt ?? Date.now(),
    units,
    stats: statsFor(units),
  };
}
