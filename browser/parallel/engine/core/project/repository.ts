import type { TaskSnapshot } from '../../types/models';
import type { AlignmentManifest } from '../align/manifest';
import {
  PaperParallelDb,
  type ProjectAiLogEntry,
  type ProjectArtifactRecord,
  type TranslationCacheRecord,
} from './db';
import {
  computeInvalidationPlan,
  type DependencyChange,
  type InvalidationResult,
} from './invalidationGraph';

export interface ProjectRepository {
  saveTask(task: TaskSnapshot): Promise<void>;
  loadTask(projectId: string): Promise<TaskSnapshot | undefined>;
  putTranslation(record: TranslationCacheRecord): Promise<void>;
  findTranslation(key: string): Promise<TranslationCacheRecord | undefined>;
  clearProjectTranslation(projectId: string): Promise<void>;
  putArtifact(record: ProjectArtifactRecord): Promise<void>;
  findArtifact(key: string): Promise<ProjectArtifactRecord | undefined>;
  saveAlignmentManifest(manifest: AlignmentManifest): Promise<void>;
  loadAlignmentManifest(projectId: string): Promise<AlignmentManifest | undefined>;
  commitValidatedOutputs(input: {
    projectId: string;
    expectedDocumentPlanDigest: string;
    artifacts: readonly ProjectArtifactRecord[];
    manifest: AlignmentManifest;
  }): Promise<void>;
  clearProjectDerivedData(projectId: string): Promise<void>;
  /** 删除排版结果但保留英文、译文以及源版式/公式缓存。 */
  clearProjectLayoutOutputs(projectId: string): Promise<void>;
  invalidateProjectDependencies(change: DependencyChange): Promise<InvalidationResult>;
  listProjectTranslations(projectId: string): Promise<TranslationCacheRecord[]>;
  listProjectArtifacts(projectId: string): Promise<ProjectArtifactRecord[]>;
  saveAiLog(projectId: string, entries: ProjectAiLogEntry[]): Promise<void>;
  loadAiLog(projectId: string): Promise<ProjectAiLogEntry[]>;
  clearAiLog(projectId: string): Promise<void>;
}

export function createProjectRepository(name = 'paper-parallel'): ProjectRepository {
  const db = new PaperParallelDb(name);

  return {
    async saveTask(task) {
      await db.tasks.put({
        projectId: task.projectId,
        stage: task.stage,
        status: task.status,
        progress: { ...task.progress },
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        updatedAt: task.updatedAt,
        error: task.error,
        pauseReason: task.pauseReason,
        visionAttempt: task.visionAttempt ? {
          ...task.visionAttempt,
          failedPages: [...task.visionAttempt.failedPages],
        } : undefined,
        settings: task.settings ? { ...task.settings } : undefined,
      });
    },

    async loadTask(projectId) {
      return db.tasks.get(projectId);
    },

    async putTranslation(record) {
      await db.translations.put(record);
    },

    async findTranslation(key) {
      return db.translations.get(key);
    },

    async clearProjectTranslation(projectId) {
      await db.translations.where('projectId').equals(projectId).delete();
    },

    async putArtifact(record) {
      await db.artifacts.put(record);
    },

    async findArtifact(key) {
      return db.artifacts.get(key);
    },

    async saveAlignmentManifest(manifest) {
      await db.artifacts.put({
        key: `${manifest.projectId}:alignment-manifest`,
        projectId: manifest.projectId,
        kind: 'alignment-manifest',
        blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
        updatedAt: manifest.createdAt,
        dependencies: {
          sourceUnitIds: manifest.units.flatMap((unit) => unit.sourceUnitIds),
        },
      });
    },

    async loadAlignmentManifest(projectId) {
      const record = await db.artifacts.get(`${projectId}:alignment-manifest`);
      if (!record) return undefined;
      return JSON.parse(await record.blob.text()) as AlignmentManifest;
    },

    async commitValidatedOutputs(input) {
      if (!input.projectId || !input.expectedDocumentPlanDigest) {
        throw new Error('正式产物提交缺少项目或文档计划摘要');
      }
      const allowedKinds = new Set<ProjectArtifactRecord['kind']>([
        'chinese-pdf', 'typst-source', 'typst-preview', 'quality-report', 'project-package',
      ]);
      if (!input.artifacts.length
        || input.artifacts.some((artifact) => (
          artifact.projectId !== input.projectId || !allowedKinds.has(artifact.kind)
        ))) {
        throw new Error('正式产物提交包含无效项目或产物类型');
      }
      const keys = input.artifacts.map((artifact) => artifact.key);
      if (new Set(keys).size !== keys.length) throw new Error('正式产物提交包含重复键');
      await db.transaction('rw', db.artifacts, async () => {
        const acceptedPlan = await db.artifacts.get(`${input.projectId}:accepted-document-plan`);
        if (acceptedPlan?.kind !== 'accepted-document-plan'
          || acceptedPlan.dependencies?.planVersion !== input.expectedDocumentPlanDigest) {
          throw new Error('页面计划已经变化，拒绝提交基于旧计划生成的正式产物');
        }
        const dependencies = { planVersion: input.expectedDocumentPlanDigest };
        const records: ProjectArtifactRecord[] = input.artifacts.map((artifact) => ({
          ...artifact,
          dependencies: { ...artifact.dependencies, ...dependencies },
        }));
        records.push({
          key: `${input.projectId}:alignment-manifest`,
          projectId: input.projectId,
          kind: 'alignment-manifest',
          blob: new Blob([JSON.stringify(input.manifest, null, 2)], { type: 'application/json' }),
          updatedAt: input.manifest.createdAt,
          dependencies: {
            sourceUnitIds: input.manifest.units.flatMap((unit) => unit.sourceUnitIds),
            planVersion: input.expectedDocumentPlanDigest,
          },
        });
        await db.artifacts.bulkPut(records);
      });
    },

    async clearProjectDerivedData(projectId) {
      await db.transaction('rw', db.translations, db.artifacts, db.aiLogs, async () => {
        await db.translations.where('projectId').equals(projectId).delete();
        await db.aiLogs.delete(projectId);
        const artifacts = await db.artifacts.where('projectId').equals(projectId).toArray();
        const derivedKeys = artifacts
          .filter((artifact) => artifact.kind !== 'english-pdf')
          .map((artifact) => artifact.key);
        if (derivedKeys.length) await db.artifacts.bulkDelete(derivedKeys);
      });
    },

    async listProjectTranslations(projectId) {
      return db.translations.where('projectId').equals(projectId).sortBy('blockId');
    },

    async listProjectArtifacts(projectId) {
      return db.artifacts.where('projectId').equals(projectId).sortBy('kind');
    },

    async clearProjectLayoutOutputs(projectId) {
      const outputKinds = new Set([
        'chinese-pdf', 'typst-source', 'typst-preview',
        'alignment-manifest', 'quality-report', 'project-package',
        'structure-diagnostic',
      ]);
      await db.transaction('rw', db.artifacts, async () => {
        const artifacts = await db.artifacts.where('projectId').equals(projectId).toArray();
        const outputKeys = artifacts
          .filter((artifact) => outputKinds.has(artifact.kind))
          .map((artifact) => artifact.key);
        if (outputKeys.length) await db.artifacts.bulkDelete(outputKeys);
      });
    },

    async invalidateProjectDependencies(change) {
      if (!change.projectId) throw new Error('Dependency invalidation requires a project id');
      let result: InvalidationResult = { artifactKeys: [], translationKeys: [] };
      await db.transaction('rw', db.translations, db.artifacts, async () => {
        const [artifacts, translations] = await Promise.all([
          db.artifacts.where('projectId').equals(change.projectId).toArray(),
          db.translations.where('projectId').equals(change.projectId).toArray(),
        ]);
        result = computeInvalidationPlan(change, artifacts, translations);
        if (result.artifactKeys.length) await db.artifacts.bulkDelete(result.artifactKeys);
        if (result.translationKeys.length) await db.translations.bulkDelete(result.translationKeys);
      });
      return result;
    },

    async saveAiLog(projectId, entries) {
      await db.aiLogs.put({
        projectId,
        entries: entries.map((entry) => ({ ...entry })),
        updatedAt: Date.now(),
      });
    },

    async loadAiLog(projectId) {
      const record = await db.aiLogs.get(projectId);
      return record?.entries.map((entry) => ({ ...entry })) ?? [];
    },

    async clearAiLog(projectId) {
      await db.aiLogs.delete(projectId);
    },
  };
}
