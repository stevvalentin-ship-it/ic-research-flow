export type AiLogEvent =
  | { type: 'vision-layout-page-started'; at: number; page: number; totalPages: number }
  | {
      type: 'vision-layout-page-phase'; at: number; page: number; totalPages: number;
      phase: 'render-retrying' | 'analysis-retrying' | 'analysis-paused';
    }
  | {
      type: 'vision-layout-page'; at: number; page: number; totalPages: number; cached: boolean;
      networkAttempts?: number; promptTokens?: number; completionTokens?: number;
    }
  | {
      type: 'vision-correction-started'; at: number; page: number; totalPages: number;
      round: 1 | 2; correctionCallsUsed: number; maxCorrectionCalls: number; errorCode: string;
      regionType: 'figure' | 'table' | 'display_formula' | 'code' | 'page';
      repairAction: 'adjust-geometry' | 'adjust-caption' | 'adjust-reading-order' | 'add-or-remove-region';
    }
  | {
      type: 'vision-correction-completed'; at: number; page: number; totalPages: number;
      round: 1 | 2; correctionCallsUsed: number; maxCorrectionCalls: number;
      promptTokens: number; completionTokens: number;
      regionType: 'figure' | 'table' | 'display_formula' | 'code' | 'page';
      repairAction: 'adjust-geometry' | 'adjust-caption' | 'adjust-reading-order' | 'add-or-remove-region';
    }
  | {
      type: 'vision-correction-stopped'; at: number; page: number; totalPages: number;
      round: 1 | 2; reason: 'budget-exhausted' | 'repeated-error' | 'no-improvement';
      correctionCallsUsed: number; maxCorrectionCalls: number;
    }
  | {
      type: 'vision-layout-fallback'; at: number; page: number; region: number;
      reason: 'low-confidence' | 'caption-unmatched' | 'page-edge-touch'
        | 'page-coverage-excessive' | 'caption-overlap' | 'foreign-caption-overlap' | 'body-prose-density'
        | 'implausible-formula-cluster';
    }
  | { type: 'vision-review-page-started'; at: number; page: number; totalPages: number }
  | {
      type: 'vision-review-page-phase'; at: number; page: number; totalPages: number;
      phase: 'render-retrying' | 'rendered' | 'connected' | 'content' | 'retrying' | 'returned';
    }
  | { type: 'vision-review-page-invalid'; at: number; page: number; totalPages: number; reason: string }
  | { type: 'vision-review-page-waiting'; at: number; page: number; totalPages: number; elapsedMs: number }
  | { type: 'vision-review-page-timeout'; at: number; page: number; totalPages: number; timeoutMs: number }
  | { type: 'vision-review-page'; at: number; page: number; totalPages: number; issueCount: number }
  | { type: 'vision-review-completed'; at: number; reviewedPages: number; issueCount: number }
  | { type: 'quality-finalizing'; at: number; visualPass: boolean; severeIssueCount: number; pendingReview?: boolean }
  | { type: 'quality-persisted'; at: number }
  | { type: 'layout-repair-started'; at: number; attempt: 1 | 2; issueCount: number }
  | { type: 'layout-repair-action'; at: number; attempt: 1 | 2; unitId: string; message: string }
  | { type: 'layout-repair-completed'; at: number; attempt: 1 | 2 }
  | { type: 'batch-started'; at: number; batchId: string; blockIds: string[]; modelId: string }
  | {
      type: 'batch-received'; at: number; batchId: string; elapsedMs: number;
      promptTokens: number; completionTokens: number;
    }
  | {
      type: 'batch-progress'; at: number; batchId: string;
      phase: 'connected' | 'reasoning' | 'content'; receivedContentChars: number;
    }
  | { type: 'batch-validated'; at: number; batchId: string; blockIds: string[] }
  | { type: 'cache-hit'; at: number; blockId: string }
  | { type: 'cache-written'; at: number; blockId: string }
  | {
      type: 'batch-split'; at: number; batchId: string;
      childBatchIds: [string, string]; reason: string;
    }
  | { type: 'retry'; at: number; batchId: string; attempt: number; reason: string }
  | { type: 'error'; at: number; batchId: string; blockIds: string[]; message: string };
