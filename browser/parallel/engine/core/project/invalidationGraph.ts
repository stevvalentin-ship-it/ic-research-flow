import type { ProjectArtifactRecord, TranslationCacheRecord } from './db';

export type DependencyFacet =
  | 'source-analysis'
  | 'page-plan'
  | 'asset-geometry'
  | 'caption-link'
  | 'semantic-content'
  | 'layout-only'
  | 'cross-page-group';

export interface DependencyChange {
  projectId: string;
  facets: DependencyFacet[];
  pageIndices?: number[];
  sourceUnitIds?: string[];
}

export interface InvalidationResult {
  artifactKeys: string[];
  translationKeys: string[];
}

const OUTPUT_KINDS = new Set<ProjectArtifactRecord['kind']>([
  'chinese-pdf', 'typst-source', 'typst-preview', 'alignment-manifest',
  'quality-report', 'project-package', 'structure-diagnostic',
]);

const PAGE_PLAN_KINDS = new Set<ProjectArtifactRecord['kind']>([
  'recovered-page-plan', 'accepted-page-plan', 'accepted-document-plan',
  'vision-correction-patch',
]);

function intersects(left: readonly number[] | undefined, right: ReadonlySet<number>): boolean {
  return Boolean(left?.some((value) => right.has(value)));
}

/** Computes the full impact before the repository deletes anything. */
export function computeInvalidationPlan(
  change: DependencyChange,
  artifacts: readonly ProjectArtifactRecord[],
  translations: readonly TranslationCacheRecord[],
): InvalidationResult {
  const facets = new Set(change.facets);
  if (facets.has('source-analysis')) {
    facets.add('page-plan');
    facets.add('asset-geometry');
  }
  const pages = new Set(change.pageIndices ?? []);
  const sourceUnits = new Set(change.sourceUnitIds ?? []);
  const formalStructureChanged = [...facets].some((facet) => facet !== 'layout-only');
  const artifactKeys = artifacts.flatMap((artifact) => {
    if (artifact.projectId !== change.projectId || artifact.kind === 'english-pdf') return [];
    if (facets.has('source-analysis')
      && (artifact.kind === 'raw-vision-response' || artifact.kind === 'vision-layout')
      && (pages.size === 0 || !artifact.dependencies?.pageIndices?.length
        || intersects(artifact.dependencies.pageIndices, pages))) return [artifact.key];
    if (OUTPUT_KINDS.has(artifact.kind) && (formalStructureChanged || facets.has('layout-only'))) {
      return [artifact.key];
    }
    if (facets.has('page-plan') || facets.has('caption-link') || facets.has('cross-page-group')) {
      if (PAGE_PLAN_KINDS.has(artifact.kind)
        && (pages.size === 0 || intersects(artifact.dependencies?.pageIndices, pages))) return [artifact.key];
    }
    if (facets.has('asset-geometry')) {
      if (artifact.kind === 'formula-ocr'
        && (pages.size === 0 || intersects(artifact.dependencies?.pageIndices, pages))) return [artifact.key];
    }
    return [];
  });
  const translationKeys = facets.has('semantic-content')
    ? translations
      .filter((record) => record.projectId === change.projectId
        && (sourceUnits.size === 0 || sourceUnits.has(record.blockId)))
      .map((record) => record.key)
    : [];
  return {
    artifactKeys: [...new Set(artifactKeys)].sort(),
    translationKeys: [...new Set(translationKeys)].sort(),
  };
}
