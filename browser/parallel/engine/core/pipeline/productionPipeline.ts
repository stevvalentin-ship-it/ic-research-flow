import type { ProjectRepository } from '../project/repository';
import { canEnterReader, type CompletionSummary } from '../task/completion';
import type { TaskSnapshot, TaskStage } from '../../types/models';
import { safeErrorMessage } from '../security/errors';
import { RecoverablePipelineError } from '../task/recoverable';
import { StructureInvariantError } from './structureInvariants';
import { MarkerInvariantError } from './markerInvariants';
import type { StructureDiagnosticReport } from '../quality/structureDiagnostic';
import { awaitWithDeadline } from '../task/asyncDeadline';
import { normalizeDeepSeekTaskSettings } from '../translate/models';

export type PipelineValue = Record<string, unknown>;

export interface TranslationProgressUpdate {
  type: 'validated' | 'retry' | 'failed';
  count: number;
}

export interface ProductionPipelineStages {
  parse(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  analyzeLayout(
    value: PipelineValue,
    signal: AbortSignal,
    reportProgress?: (attempt: NonNullable<TaskSnapshot['visionAttempt']>) => void,
  ): Promise<PipelineValue>;
  buildGlossary(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  translate(
    value: PipelineValue,
    signal: AbortSignal,
    reportProgress?: (event: TranslationProgressUpdate) => void,
  ): Promise<PipelineValue>;
  compose(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  compile(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  align(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  validate(value: PipelineValue, signal: AbortSignal): Promise<CompletionSummary>;
  /** Releases PDF.js documents and other per-run resources on every terminal path. */
  dispose?(value: PipelineValue): Promise<void>;
}

export interface ProductionPipelineOptions {
  snapshot: TaskSnapshot;
  repository: ProjectRepository;
  signal: AbortSignal;
  stages: ProductionPipelineStages;
  onSnapshot?(snapshot: TaskSnapshot): void;
}

export interface ProductionPipelineResult {
  snapshot: TaskSnapshot;
  completion: CompletionSummary;
  value: PipelineValue;
}

function abortError(): DOMException {
  return new DOMException('任务已安全停止', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

export async function runProductionPipeline(
  options: ProductionPipelineOptions,
): Promise<ProductionPipelineResult> {
  let snapshot: TaskSnapshot = {
    ...options.snapshot,
    settings: options.snapshot.settings ? normalizeDeepSeekTaskSettings(options.snapshot.settings) : undefined,
    visionAttempt: undefined,
    progress: { ...options.snapshot.progress },
    error: undefined,
    pauseReason: undefined,
  };
  const resumableTranslationProgress = options.snapshot.stage === 'translating'
    ? { ...options.snapshot.progress }
    : undefined;
  const persist = async (notify = true): Promise<void> => {
    throwIfAborted(options.signal);
    snapshot = { ...snapshot, progress: { ...snapshot.progress } };
    if (notify) options.onSnapshot?.(snapshot);
    await awaitWithDeadline(options.repository.saveTask(snapshot), { signal: options.signal, timeoutMs: 30_000 });
  };
  const enter = async (stage: TaskStage): Promise<void> => {
    throwIfAborted(options.signal);
    snapshot = {
      ...snapshot,
      stage,
      status: 'running',
      startedAt: snapshot.startedAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    await persist();
  };
  const run = async (
    stage: TaskStage,
    operation: (value: PipelineValue, signal: AbortSignal) => Promise<PipelineValue>,
    value: PipelineValue,
  ): Promise<PipelineValue> => {
    await enter(stage);
    throwIfAborted(options.signal);
    const next = await awaitWithDeadline(operation(value, options.signal), { signal: options.signal });
    throwIfAborted(options.signal);
    const taskValue = next as PipelineValue & {
      settings?: TaskSnapshot['settings'];
      visionAttempt?: TaskSnapshot['visionAttempt'];
    };
    if (taskValue.settings || taskValue.visionAttempt) {
      snapshot = {
        ...snapshot,
        ...(taskValue.settings ? { settings: { ...taskValue.settings } } : {}),
        ...(taskValue.visionAttempt ? {
          visionAttempt: {
            ...taskValue.visionAttempt,
            failedPages: [...taskValue.visionAttempt.failedPages],
          },
        } : {}),
        updatedAt: Date.now(),
      };
      await persist(false);
    }
    return next;
  };
  let value: PipelineValue = { projectId: snapshot.projectId, settings: snapshot.settings };

  try {
    value = await run('parsing', options.stages.parse, value);
    value = await run('analyzing-layout', (input, signal) => options.stages.analyzeLayout(input, signal, (attempt) => {
      if (signal.aborted || snapshot.stage !== 'analyzing-layout') return;
      snapshot = {
        ...snapshot,
        visionAttempt: { ...attempt, failedPages: [...attempt.failedPages] },
        updatedAt: Date.now(),
      };
      options.onSnapshot?.(snapshot);
    }), value);
    value = await run('building-glossary', options.stages.buildGlossary, value);

    const requiredBlocks = Number(value.requiredBlocks) || 0;
    const baselineProgress = resumableTranslationProgress?.total === requiredBlocks
      ? { ...resumableTranslationProgress, total: requiredBlocks }
      : { completed: 0, total: requiredBlocks, retries: 0, failed: 0 };
    snapshot = { ...snapshot, progress: { ...baselineProgress } };
    await enter('translating');
    let progressPersistence = Promise.resolve();
    let progressPersistenceError: unknown;
    let translationActive = true;
    let observedCompleted = 0;
    let observedRetries = 0;
    let observedFailed = 0;
    const reportTranslationProgress = (event: TranslationProgressUpdate): void => {
      if (options.signal.aborted || !translationActive) return;
      if (!Number.isInteger(event.count) || event.count < 1) return;
      if (event.type === 'validated') {
        observedCompleted += event.count;
      } else if (event.type === 'retry') {
        observedRetries += event.count;
      } else {
        observedFailed += event.count;
      }
      const completed = Math.min(requiredBlocks, Math.max(baselineProgress.completed, observedCompleted));
      const progress = {
        completed,
        total: requiredBlocks,
        retries: baselineProgress.retries + observedRetries,
        failed: Math.min(
          Math.max(0, requiredBlocks - completed),
          Math.max(baselineProgress.failed, observedFailed),
        ),
      };
      snapshot = { ...snapshot, progress, updatedAt: Date.now() };
      const progressSnapshot = { ...snapshot, progress: { ...snapshot.progress } };
      options.onSnapshot?.(progressSnapshot);
      progressPersistence = progressPersistence.then(async () => {
        if (options.signal.aborted) return;
        await awaitWithDeadline(options.repository.saveTask(progressSnapshot), { signal: options.signal, timeoutMs: 30_000 });
      }).catch((error) => { progressPersistenceError ??= error; });
    };
    try {
      value = await awaitWithDeadline(
        options.stages.translate(value, options.signal, reportTranslationProgress), { signal: options.signal },
      );
    } finally {
      translationActive = false;
      await awaitWithDeadline(progressPersistence, { signal: options.signal });
    }
    if (progressPersistenceError) throw progressPersistenceError;
    snapshot = {
      ...snapshot,
      progress: {
        ...snapshot.progress,
        completed: Math.min(requiredBlocks, Number(value.validatedBlocks) || 0),
        failed: 0,
      },
      updatedAt: Date.now(),
    };
    await persist(false);

    value = await run('composing', options.stages.compose, value);
    value = await run('compiling', options.stages.compile, value);
    value = await run('aligning', options.stages.align, value);
    await enter('validating');
    const completion = await awaitWithDeadline(options.stages.validate(value, options.signal), { signal: options.signal });
    throwIfAborted(options.signal);
    if (!canEnterReader(completion)) throw new Error('质量门未通过，不能自动进入阅读器');

    snapshot = {
      ...snapshot,
      stage: 'completed',
      status: 'completed',
      error: undefined,
      pauseReason: undefined,
      updatedAt: Date.now(),
    };
    await persist();
    return { snapshot, completion, value };
  } catch (error) {
    if (options.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError();
    if (error instanceof RecoverablePipelineError) {
      snapshot = {
        ...snapshot,
        status: 'paused',
        pauseReason: error.pauseReason,
        ...(error.visionAttempt ? {
          visionAttempt: {
            ...error.visionAttempt,
            failedPages: [...error.visionAttempt.failedPages],
          },
          settings: snapshot.settings ? {
            ...snapshot.settings,
            ...(error.visionAttempt.maxCorrectionCalls > 0 ? {
              maxVisionCorrectionCalls: error.visionAttempt.maxCorrectionCalls,
            } : {}),
          } : snapshot.settings,
        } : {}),
        error: safeErrorMessage(error, 500),
        updatedAt: Date.now(),
      };
      try { await persist(); } catch { /* Preserve the recoverable error when storage is unavailable. */ }
      throw error;
    }
    {
      const diagnostic: StructureDiagnosticReport = {
        schemaVersion: 1,
        projectId: snapshot.projectId,
        createdAt: Date.now(),
        errorName: error instanceof Error ? safeErrorMessage(error.name, 100) : 'PipelineError',
        stage: snapshot.stage,
        message: safeErrorMessage(error, 500),
        issues: error instanceof StructureInvariantError || error instanceof MarkerInvariantError ? error.issues : [],
      };
      try {
        await awaitWithDeadline(options.repository.putArtifact({
          key: `${snapshot.projectId}:structure-diagnostic`,
          projectId: snapshot.projectId,
          kind: 'structure-diagnostic',
          blob: new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json' }),
          updatedAt: diagnostic.createdAt,
        }), { signal: options.signal, timeoutMs: 5_000 });
      } catch {
        // The original structural failure remains authoritative when local
        // diagnostic persistence is unavailable.
      }
    }
    snapshot = {
      ...snapshot,
      status: 'failed',
      pauseReason: undefined,
      error: safeErrorMessage(error, 500),
      updatedAt: Date.now(),
    };
    try { await persist(); } catch { /* Preserve the original stage failure. */ }
    throw error;
  } finally {
    try {
      await awaitWithDeadline(Promise.resolve().then(() => options.stages.dispose?.(value)), {
        signal: options.signal, timeoutMs: 5_000,
      });
    } catch {
      // Cleanup must not replace the actual pipeline result or failure.
    }
  }
}
