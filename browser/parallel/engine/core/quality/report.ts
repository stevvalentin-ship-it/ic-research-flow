import type { LayoutRepairAction } from '../typst/project';
import type { VisionFinalIssue } from '../vision/finalReview';
import type { CrossPageAssetGroup } from '../vision/crossPageRelations';
import type { AlignmentGateIssue } from './alignmentGate';

export interface QualityAttemptReport {
  attempt: 0 | 1 | 2;
  pass: boolean;
  reviewedPages: number;
  issues: VisionFinalIssue[];
  actions: LayoutRepairAction[];
}

export interface SourceLayoutCorrectionAttempt {
  pageIndex: number;
  round: 1 | 2;
  basePlanVersion: string;
  patchId?: string;
  errorFingerprints: string[];
  outcome: 'patched' | 'accepted' | 'rejected' | 'request-failed';
  networkAttempts: number;
  promptTokens: number;
  completionTokens: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface SourceLayoutRunHistory {
  runStartedAt: number;
  completedAt: number;
  pass: boolean;
  initialAnalysisCalls: number;
  correctionCallsUsed: number;
  maxCorrectionCalls: number;
  promptTokens: number;
  completionTokens: number;
  correctionAttempts: SourceLayoutCorrectionAttempt[];
  unresolvedIssues: SourceLayoutQualityReport['unresolvedIssues'];
}

export interface SourceLayoutQualityReport {
  schemaVersion: 1 | 2;
  /** Present in schema v2; older reports remain readable. */
  runStartedAt?: number;
  completedAt?: number;
  /** Bounded summaries of earlier runs preserved across failed-page reanalysis. */
  runHistory?: SourceLayoutRunHistory[];
  pass: boolean;
  pagePlans: Array<{
    pageIndex: number;
    planVersion: string;
    planDigest: string;
    origin: 'initial' | 'correction-1' | 'correction-2';
    recoveryActions: Array<{ type: string; regionId: string; reason: string }>;
  }>;
  correctionAttempts: SourceLayoutCorrectionAttempt[];
  initialAnalysisCalls: number;
  initialPromptTokens: number;
  initialCompletionTokens: number;
  correctionCallsUsed: number;
  maxCorrectionCalls: number;
  promptTokens: number;
  completionTokens: number;
  unresolvedIssues: Array<{
    pageIndex: number;
    regionId?: string;
    code: string;
    reason: string;
    fingerprint: string;
  }>;
  crossPageAssetGroups: CrossPageAssetGroup[];
}

export interface QualityReport {
  deliveryStatus?: 'verified' | 'needs-review';
  alignmentIssues?: AlignmentGateIssue[];
  schemaVersion: 1 | 2;
  projectId: string;
  layoutProfileVersion: string;
  pass: boolean;
  createdAt: number;
  attempts: QualityAttemptReport[];
  /** Absent only on legacy reports created before source-plan provenance existed. */
  sourceLayout?: SourceLayoutQualityReport;
}

export function preserveSourceLayoutRunHistory(
  previous: SourceLayoutQualityReport | undefined,
  fallbackTimestamp: number,
  limit = 8,
): SourceLayoutRunHistory[] {
  if (!previous) return [];
  const current: SourceLayoutRunHistory = {
    runStartedAt: previous.runStartedAt ?? fallbackTimestamp,
    completedAt: previous.completedAt ?? fallbackTimestamp,
    pass: previous.pass,
    initialAnalysisCalls: previous.initialAnalysisCalls,
    correctionCallsUsed: previous.correctionCallsUsed,
    maxCorrectionCalls: previous.maxCorrectionCalls,
    promptTokens: previous.promptTokens,
    completionTokens: previous.completionTokens,
    correctionAttempts: previous.correctionAttempts.slice(0, 64).map((attempt) => ({
      ...attempt, errorFingerprints: [...attempt.errorFingerprints],
    })),
    unresolvedIssues: previous.unresolvedIssues.slice(0, 128).map((issue) => ({ ...issue })),
  };
  return [...(previous.runHistory ?? []), current]
    .slice(-Math.max(1, limit))
    .map((run) => ({
      ...run,
      correctionAttempts: run.correctionAttempts.map((attempt) => ({
        ...attempt, errorFingerprints: [...attempt.errorFingerprints],
      })),
      unresolvedIssues: run.unresolvedIssues.map((issue) => ({ ...issue })),
    }));
}
