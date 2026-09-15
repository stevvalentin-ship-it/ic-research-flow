import Dexie, { type EntityTable } from 'dexie';
import type { TaskSnapshot } from '../../types/models';
import type { AiLogEvent } from '../translate/events';

export interface ProjectAiLogEntry {
  at: number;
  type: AiLogEvent['type'];
  batchId?: string;
  page?: number;
  totalPages?: number;
  reviewedPages?: number;
  attempt?: number;
  round?: number;
  correctionCallsUsed?: number;
  maxCorrectionCalls?: number;
  promptTokens?: number;
  completionTokens?: number;
  networkAttempts?: number;
  errorCode?: string;
  regionType?: 'figure' | 'table' | 'display_formula' | 'code' | 'page';
  repairAction?: 'adjust-geometry' | 'adjust-caption' | 'adjust-reading-order' | 'add-or-remove-region';
  message: string;
}

export interface ProjectAiLogRecord {
  projectId: string;
  entries: ProjectAiLogEntry[];
  updatedAt: number;
}

export interface TranslationAlignmentGroupRecord {
  sourceSentenceIds: string[];
  targetSegments: string[];
}

export interface TranslationCacheRecord {
  key: string;
  projectId: string;
  blockId: string;
  translation: string;
  alignmentGroups: TranslationAlignmentGroupRecord[];
  validatedAt: number;
}

export type ProjectArtifactKind =
  | 'english-pdf'
  | 'chinese-pdf'
  | 'typst-source'
  | 'typst-preview'
  | 'alignment-manifest'
  /** Legacy accepted layout cache; retained for read compatibility only. */
  | 'vision-layout'
  | 'raw-vision-response'
  | 'vision-correction-patch'
  | 'recovered-page-plan'
  | 'accepted-page-plan'
  | 'accepted-document-plan'
  | 'vision-diagnostic'
  | 'structure-diagnostic'
  | 'formula-ocr'
  | 'quality-report'
  | 'project-package';

export interface ProjectArtifactRecord {
  key: string;
  projectId: string;
  kind: ProjectArtifactKind;
  blob: Blob;
  updatedAt: number;
  /** Optional dependency metadata for precise transactional invalidation. */
  dependencies?: {
    pageIndices?: number[];
    sourceUnitIds?: string[];
    planVersion?: string;
    cacheIdentityVersion?: string;
  };
}

export class PaperParallelDb extends Dexie {
  tasks!: EntityTable<TaskSnapshot, 'projectId'>;
  translations!: EntityTable<TranslationCacheRecord, 'key'>;
  artifacts!: EntityTable<ProjectArtifactRecord, 'key'>;
  aiLogs!: EntityTable<ProjectAiLogRecord, 'projectId'>;

  constructor(name = 'paper-parallel') {
    super(name);
    this.version(1).stores({
      tasks: 'projectId,updatedAt',
      translations: 'key,projectId,blockId',
      artifacts: 'key,projectId,kind',
    });
    this.version(2).stores({
      tasks: 'projectId,updatedAt',
      translations: 'key,projectId,blockId',
      artifacts: 'key,projectId,kind',
      aiLogs: 'projectId,updatedAt',
    });
  }
}
