import type { ProjectArtifactRecord } from '../project/db';
import type { TypstCompileResult } from '../typst/compiler';
import { buildTypstProject, type TypstProject, type TypstProjectInput } from '../typst/project';

export type CompositionPhase = 'composing' | 'compiling-pdf' | 'persisting-pdf';
export interface CompositionProgress { phase: CompositionPhase; at: number }

export interface ChineseCompositionInput extends TypstProjectInput {
  projectId: string;
}

export interface CompositionDependencies {
  compile(project: TypstProject, signal?: AbortSignal): Promise<TypstCompileResult>;
  saveArtifact(record: ProjectArtifactRecord): Promise<void>;
  onProgress(event: CompositionProgress): void;
  signal?: AbortSignal;
  now?: () => number;
}

export interface ChineseCompositionResult extends TypstCompileResult {
  pdfKey: string;
  sourceKey: string;
  previewKey: string;
  markerIds: string[];
}

function validateSourceOrder(input: ChineseCompositionInput): void {
  const regionIds = new Set(input.regions.map((region) => region.id));
  if (regionIds.size !== input.regions.length) throw new Error('Duplicate layout region ID');
  let priorOrder = -Infinity;
  for (const region of input.regions) {
    for (const unitId of region.orderedUnitIds) {
      const unit = input.units.find((candidate) => candidate.id === unitId);
      if (!unit) throw new Error(`Missing semantic unit: ${unitId}`);
      if (unit.order < priorOrder) throw new Error(`Semantic unit order changed at ${unitId}`);
      priorOrder = unit.order;
      if (!unit.assetId && !unit.text && !unit.targetSegments?.length) {
        throw new Error(`Translated content is missing for ${unitId}`);
      }
    }
  }
}

export async function composeChinesePdf(
  input: ChineseCompositionInput,
  dependencies: CompositionDependencies,
): Promise<ChineseCompositionResult> {
  if (dependencies.signal?.aborted) throw new DOMException('Composition stopped', 'AbortError');
  const now = dependencies.now ?? Date.now;
  dependencies.onProgress({ phase: 'composing', at: now() });
  validateSourceOrder(input);
  const project = await buildTypstProject(input);

  dependencies.onProgress({ phase: 'compiling-pdf', at: now() });
  const compiled = await dependencies.compile(project, dependencies.signal);
  if (compiled.pdf.length < 4 || new TextDecoder().decode(compiled.pdf.slice(0, 4)) !== '%PDF') {
    throw new Error('Typst compiler did not return a PDF');
  }
  if (!compiled.svg.includes('<svg')) throw new Error('Typst compiler did not return an SVG preview');

  dependencies.onProgress({ phase: 'persisting-pdf', at: now() });
  const updatedAt = now();
  const pdfKey = `${input.projectId}:chinese-pdf`;
  const sourceKey = `${input.projectId}:typst-source`;
  const previewKey = `${input.projectId}:typst-preview`;
  const records: ProjectArtifactRecord[] = [
    {
      key: pdfKey, projectId: input.projectId, kind: 'chinese-pdf',
      blob: new Blob([new Uint8Array(compiled.pdf)], { type: 'application/pdf' }), updatedAt,
    },
    {
      key: sourceKey, projectId: input.projectId, kind: 'typst-source',
      blob: new Blob([project.mainContent], { type: 'text/plain;charset=utf-8' }), updatedAt,
    },
    {
      key: previewKey, projectId: input.projectId, kind: 'typst-preview',
      blob: new Blob([compiled.svg], { type: 'image/svg+xml' }), updatedAt,
    },
  ];
  for (const record of records) await dependencies.saveArtifact(record);
  return { ...compiled, pdfKey, sourceKey, previewKey, markerIds: [...project.markerIds] };
}
