import JSZip from 'jszip';
import { hashBlob } from '../assets/hash';
import { SYSTEM_PROMPT_VERSION } from '../translate/prompts';
import { REQUIRED_VISION_MODEL_ID } from '../vision/model';
import type { ProjectRepository } from './repository';

export interface ProjectPackageContext {
  project?: {
    name?: string;
    sourceFileHash?: string;
    modelId?: string;
    visionModelId?: string;
    thinkingMode?: 'enabled' | 'disabled';
    targetLayoutPolicy?: 'single-column' | 'source-layout';
    layoutProfileVersion?: string;
    pageCounts?: { en: number; zh: number };
  };
  glossary?: unknown;
  sourceUnits?: unknown;
  targetUnits?: unknown;
  assets?: unknown;
  audit?: unknown;
}

const SENSITIVE_KEYS = new Set(['apikey', 'authorization', 'reasoning_content']);
const KEY_VALUE_PATTERN = /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]+/;

function assertSecretFree(value: unknown, key = ''): void {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) throw new Error('项目包包含敏感字段');
  if (typeof value === 'string') {
    if (KEY_VALUE_PATTERN.test(value) || /\bAuthorization\b/i.test(value) || /reasoning_content/i.test(value)) {
      throw new Error('项目包包含敏感字段');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => assertSecretFree(entry));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => assertSecretFree(child, childKey));
  }
}

function json(value: unknown): string {
  assertSecretFree(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function buildProjectPackage(
  projectId: string,
  repository: ProjectRepository,
  context: ProjectPackageContext = {},
): Promise<Blob> {
  const [task, translations, artifacts, alignment] = await Promise.all([
    repository.loadTask(projectId),
    repository.listProjectTranslations(projectId),
    repository.listProjectArtifacts(projectId),
    repository.loadAlignmentManifest(projectId),
  ]);
  const byKind = new Map(artifacts.map((artifact) => [artifact.kind, artifact]));
  const english = byKind.get('english-pdf');
  const chinese = byKind.get('chinese-pdf');
  const typst = byKind.get('typst-source');
  const qualityReport = byKind.get('quality-report');
  const acceptedDocumentPlan = byKind.get('accepted-document-plan');
  if (!english || !chinese) throw new Error('项目包缺少英文或中文 PDF');

  const checksums: Record<string, string> = {
    'english.pdf': await hashBlob(english.blob),
    'chinese.pdf': await hashBlob(chinese.blob),
  };
  if (typst) checksums['translation.typ'] = await hashBlob(typst.blob);
  if (qualityReport) checksums['quality-report.json'] = await hashBlob(qualityReport.blob);
  if (acceptedDocumentPlan) checksums['layout-plan.json'] = await hashBlob(acceptedDocumentPlan.blob);
  const project = {
    schemaVersion: 3,
    projectId,
    name: context.project?.name ?? task?.settings?.sourceFileName ?? projectId,
    createdAt: task?.createdAt ?? null,
    updatedAt: task?.updatedAt ?? Math.max(english.updatedAt, chinese.updatedAt),
    promptVersion: SYSTEM_PROMPT_VERSION,
    modelId: context.project?.modelId ?? task?.settings?.modelId ?? null,
    visionModelId: context.project?.visionModelId
      ?? task?.settings?.visionModelId
      ?? REQUIRED_VISION_MODEL_ID,
    thinkingMode: context.project?.thinkingMode ?? task?.settings?.thinkingMode ?? null,
    targetLayoutPolicy: context.project?.targetLayoutPolicy
      ?? task?.settings?.targetLayoutPolicy
      ?? 'source-layout',
    layoutProfileVersion: context.project?.layoutProfileVersion
      ?? task?.settings?.layoutProfileVersion
      ?? 'legacy-source-layout',
    sourceFileHash: context.project?.sourceFileHash ?? task?.settings?.sourceFileHash ?? null,
    pageCounts: context.project?.pageCounts ?? null,
    artifactChecksums: checksums,
    visionPlanSchemaVersion: acceptedDocumentPlan ? 1 : null,
  };
  const translation = translations.map(({ key: _key, projectId: _projectId, ...record }) => record);
  const sourceUnits = context.sourceUnits ?? alignment?.units.flatMap((unit) => unit.sourceUnitIds) ?? [];
  const targetUnits = context.targetUnits ?? alignment?.units.flatMap((unit) => unit.targetUnitIds) ?? [];
  const textFiles: Record<string, string> = {
    'project.json': json(project),
    'quality-report.json': qualityReport ? await qualityReport.blob.text() : json(null),
    'alignment.json': json(alignment ?? null),
    'assets.json': json(context.assets ?? { assets: [] }),
    'audit.json': json(context.audit ?? { issues: [] }),
    'glossary.json': json(context.glossary ?? []),
    'source-units.json': json(sourceUnits),
    'target-units.json': json(targetUnits),
    'translation.json': json(translation),
    'translation.typ': typst ? await typst.blob.text() : '',
  };
  if (acceptedDocumentPlan) textFiles['layout-plan.json'] = await acceptedDocumentPlan.blob.text();
  Object.values(textFiles).forEach((text) => assertSecretFree(text));

  const zip = new JSZip();
  Object.entries(textFiles).forEach(([name, content]) => zip.file(name, content));
  zip.file('english.pdf', new Uint8Array(await english.blob.arrayBuffer()));
  zip.file('chinese.pdf', new Uint8Array(await chinese.blob.arrayBuffer()));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
