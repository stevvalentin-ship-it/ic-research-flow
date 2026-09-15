import type { TranslationBatch } from './batcher';
import type { AiLogEvent } from './events';
import type {
  TranslationBlockRequest,
  TranslationBlockResponse,
  TranslationResponse,
  TranslationValidationIssue,
} from './protocol';
import { validateBatchResponse } from './protected';
import { safeErrorMessage } from '../security/errors';
import { CachePersistenceError } from '../project/cacheErrors';

export interface TranslationRequestResult extends TranslationResponse {
  usage: { promptTokens: number; completionTokens: number };
}

export interface TranslationTaskOptions {
  projectId: string;
  modelId: string;
  batches: readonly TranslationBatch[];
  concurrency: number;
  maxRetries: number;
  signal?: AbortSignal;
  request(batch: TranslationBatch, signal?: AbortSignal): Promise<TranslationRequestResult>;
  findCached(block: TranslationBlockRequest): Promise<TranslationBlockResponse | undefined>;
  saveValidated(record: TranslationBlockResponse): Promise<void>;
  /** Runs after response validation and before persistence; returned IDs are committed in memory. */
  validateAccepted?(
    record: TranslationBlockResponse,
    request: TranslationBlockRequest,
    committedMarkerIds: ReadonlySet<string>,
  ): readonly string[];
  isNonRetryableError?(error: unknown): boolean;
  onEvent(event: AiLogEvent): void;
  now?: () => number;
}

export interface TranslationTaskResult {
  completedBlockIds: string[];
  cachedBlockIds: string[];
  translations: TranslationBlockResponse[];
  usage: { promptTokens: number; completionTokens: number };
}

class TranslationValidationError extends Error {
  readonly issues: TranslationValidationIssue[];
  readonly codes: string[];
  readonly blockIds: string[];
  readonly details: string[];

  constructor(issues: TranslationValidationIssue[]) {
    const codes = issues.map((issue) => issue.code);
    const blockIds = [...new Set(issues.map((issue) => issue.blockId).filter((id) => id !== '*'))];
    const details = [...new Set(issues.map((issue) => issue.message))];
    super([
      `Translation validation failed for ${blockIds.join(', ') || 'unknown blocks'}: ${codes.join(', ')}`,
      ...details,
    ].join('; '));
    this.name = 'TranslationValidationError';
    this.issues = issues;
    this.codes = codes;
    this.blockIds = blockIds;
    this.details = details;
  }
}

function abortError(): DOMException {
  return new DOMException('Stopped', 'AbortError');
}

function combineAbortSignals(signals: readonly AbortSignal[]): {
  signal: AbortSignal;
  cleanup(): void;
} {
  const nativeAny = (AbortSignal as typeof AbortSignal & {
    any?: (sources: AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof nativeAny === 'function') {
    return { signal: nativeAny.call(AbortSignal, [...signals]), cleanup: () => undefined };
  }

  const controller = new AbortController();
  const listening: AbortSignal[] = [];
  const forwardAbort = (): void => { controller.abort(); };
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', forwardAbort, { once: true });
    listening.push(signal);
  }
  return {
    signal: controller.signal,
    cleanup: () => listening.forEach((signal) => signal.removeEventListener('abort', forwardAbort)),
  };
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === 'AbortError');
}

function isOutputLimitError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'DeepSeekOutputLimitError';
}

function isAdaptiveSplitError(error: unknown): error is Error {
  return error instanceof Error && [
    'DeepSeekOutputLimitError',
    'DeepSeekProtocolError',
    'TranslationValidationError',
  ].includes(error.name);
}

function splitBatch(batch: TranslationBatch): [TranslationBatch, TranslationBatch] {
  const midpoint = Math.ceil(batch.blocks.length / 2);
  const child = (suffix: 'a' | 'b', blocks: TranslationBlockRequest[]): TranslationBatch => ({
    ...batch,
    id: `${batch.id}${suffix}`,
    blocks,
    estimatedTokens: Math.ceil(batch.estimatedTokens * blocks.length / batch.blocks.length),
  });
  return [
    child('a', batch.blocks.slice(0, midpoint)),
    child('b', batch.blocks.slice(midpoint)),
  ];
}

export async function runTranslationTask(
  options: TranslationTaskOptions,
): Promise<TranslationTaskResult> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }
  if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
    throw new Error('maxRetries must be a non-negative integer');
  }
  if (options.signal?.aborted) throw abortError();

  const now = options.now ?? Date.now;
  const fatalController = new AbortController();
  const combinedSignal = combineAbortSignals(
    options.signal ? [options.signal, fatalController.signal] : [fatalController.signal],
  );
  const taskSignal = combinedSignal.signal;
  try {
  const completed = new Map<string, TranslationBlockResponse>();
  const cached = new Set<string>();
  const committedMarkerIds = new Set<string>();
  const usage = { promptTokens: 0, completionTokens: 0 };
  let nextBatchIndex = 0;
  let fatalError: unknown;
  const deferredValidationErrors: TranslationValidationError[] = [];

  const processBatch = async (batch: TranslationBatch): Promise<void> => {
    const missing: TranslationBlockRequest[] = [];
    for (const block of batch.blocks) {
      if (taskSignal.aborted) throw abortError();
      const cachedRecord = await options.findCached(block);
      if (taskSignal.aborted) throw abortError();
      if (cachedRecord) {
        const cachedValidation = validateBatchResponse([block], { blocks: [cachedRecord] });
        if (cachedValidation.ok) {
          const markerIds = options.validateAccepted?.(cachedRecord, block, committedMarkerIds) ?? [];
          markerIds.forEach((id) => committedMarkerIds.add(id));
          completed.set(block.blockId, cachedRecord);
          cached.add(block.blockId);
          options.onEvent({ type: 'cache-hit', at: now(), blockId: block.blockId });
        } else {
          missing.push(block);
        }
      } else {
        missing.push(block);
      }
    }
    if (missing.length === 0) return;

    let pendingBlocks = missing;
    let standardRetries = 0;
    let retryCount = 0;
    let repairAttempts = 0;
    let recovery: TranslationBatch['recovery'];
    while (true) {
      if (taskSignal.aborted) throw abortError();
      const pendingBatch: TranslationBatch = { ...batch, blocks: pendingBlocks, recovery };
      const startedAt = now();
      options.onEvent({
        type: 'batch-started',
        at: startedAt,
        batchId: batch.id,
        blockIds: pendingBlocks.map((block) => block.blockId),
        modelId: options.modelId,
      });

      try {
        const response = await options.request(pendingBatch, taskSignal);
        usage.promptTokens += response.usage.promptTokens;
        usage.completionTokens += response.usage.completionTokens;
        options.onEvent({
          type: 'batch-received',
          at: now(),
          batchId: batch.id,
          elapsedMs: Math.max(0, now() - startedAt),
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
        });

        const validation = validateBatchResponse(pendingBlocks, response);
        if (validation.accepted.length) {
          const persisted: TranslationBlockResponse[] = [];
          const publishPersisted = (): void => {
            if (!persisted.length) return;
            options.onEvent({
              type: 'batch-validated', at: now(), batchId: batch.id,
              blockIds: persisted.map((record) => record.blockId),
            });
            for (const record of persisted) {
              options.onEvent({ type: 'cache-written', at: now(), blockId: record.blockId });
            }
            persisted.length = 0;
          };
          for (const record of validation.accepted) {
            const request = pendingBlocks.find((block) => block.blockId === record.blockId);
            if (!request) throw new Error(`Validated translation references unknown block ${record.blockId}`);
            const markerIds = options.validateAccepted?.(record, request, committedMarkerIds) ?? [];
            markerIds.forEach((id) => committedMarkerIds.add(id));
            let persistenceAttempt = 0;
            while (true) {
              try {
                await options.saveValidated(record);
                break;
              } catch (error) {
                if (persistenceAttempt >= options.maxRetries) {
                  publishPersisted();
                  throw new CachePersistenceError(
                    `翻译缓存 ${record.blockId} 写入失败；不会重复请求 API`,
                    error,
                  );
                }
                persistenceAttempt += 1;
                retryCount += 1;
                options.onEvent({
                  type: 'retry', at: now(), batchId: batch.id, attempt: retryCount,
                  reason: `本地缓存写入失败，正在重试持久化（不重复请求 API）：${safeErrorMessage(error)}`,
                });
              }
            }
            completed.set(record.blockId, record);
            pendingBlocks = pendingBlocks.filter((block) => block.blockId !== record.blockId);
            persisted.push(record);
          }
          publishPersisted();
        }
        if (pendingBlocks.length === 0) return;
        throw new TranslationValidationError(validation.issues);
      } catch (error) {
        if (isAbortError(error, taskSignal)) throw abortError();
        if (error instanceof CachePersistenceError || options.isNonRetryableError?.(error)) {
          options.onEvent({
            type: 'error', at: now(), batchId: batch.id,
            blockIds: pendingBlocks.map((block) => block.blockId), message: safeErrorMessage(error),
          });
          throw error;
        }
        const reason = safeErrorMessage(error);
        if (isAdaptiveSplitError(error) && pendingBlocks.length > 1) {
          const children = splitBatch({ ...batch, blocks: pendingBlocks, recovery: undefined });
          options.onEvent({
            type: 'batch-split', at: now(), batchId: batch.id,
            childBatchIds: [children[0].id, children[1].id], reason,
          });
          const childValidationErrors: TranslationValidationError[] = [];
          for (const child of children) {
            try {
              await processBatch(child);
            } catch (childError) {
              if (!(childError instanceof TranslationValidationError)) throw childError;
              childValidationErrors.push(childError);
            }
          }
          if (childValidationErrors.length) {
            throw new TranslationValidationError(childValidationErrors.flatMap((item) => item.issues));
          }
          return;
        }
        if (
          pendingBlocks.length === 1
          && repairAttempts < options.maxRetries
          && (isOutputLimitError(error) || error instanceof TranslationValidationError)
        ) {
          repairAttempts += 1;
          recovery = {
            disableThinking: true,
            reason: isOutputLimitError(error) ? 'output-limit' : 'validation',
            ...(error instanceof TranslationValidationError ? {
              validationCodes: error.codes,
              validationDetails: error.details,
            } : {}),
          };
          retryCount += 1;
          options.onEvent({
            type: 'retry', at: now(), batchId: batch.id, attempt: retryCount,
            reason: recovery.reason === 'output-limit'
              ? '单块响应仍过长，已切换无思考修复请求'
              : [
                `单块未通过校验，已切换无思考分片修复请求（${recovery.validationCodes?.join(', ') ?? 'validation'}）`,
                ...(recovery.validationDetails?.slice(0, 3) ?? []),
              ].join('：'),
          });
          continue;
        }
        if (recovery !== undefined) {
          options.onEvent({
            type: 'error', at: now(), batchId: batch.id,
            blockIds: pendingBlocks.map((block) => block.blockId), message: reason,
          });
          throw error;
        }
        if (isOutputLimitError(error)) {
          options.onEvent({
            type: 'error', at: now(), batchId: batch.id,
            blockIds: pendingBlocks.map((block) => block.blockId), message: reason,
          });
          throw error;
        }
        if (standardRetries < options.maxRetries) {
          standardRetries += 1;
          retryCount += 1;
          options.onEvent({
            type: 'retry', at: now(), batchId: batch.id, attempt: retryCount, reason,
          });
          continue;
        }
        options.onEvent({
          type: 'error', at: now(), batchId: batch.id,
          blockIds: pendingBlocks.map((block) => block.blockId), message: reason,
        });
        throw error;
      }
    }
  };

  const worker = async (): Promise<void> => {
    while (fatalError === undefined) {
      if (taskSignal.aborted) throw abortError();
      const index = nextBatchIndex;
      nextBatchIndex += 1;
      if (index >= options.batches.length) return;
      try {
        await processBatch(options.batches[index]!);
      } catch (error) {
        if (error instanceof TranslationValidationError) {
          deferredValidationErrors.push(error);
          continue;
        }
        if (fatalError === undefined) {
          fatalError = error;
          fatalController.abort();
        }
        throw error;
      }
    }
  };

  const workerCount = Math.min(options.concurrency, options.batches.length);
  const settled = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  if (fatalError !== undefined) throw fatalError;
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  if (deferredValidationErrors.length) {
    throw new TranslationValidationError(deferredValidationErrors.flatMap((item) => item.issues));
  }

  const sourceOrder = options.batches.flatMap((batch) => batch.blocks.map((block) => block.blockId));
  const completedBlockIds = sourceOrder.filter((blockId) => completed.has(blockId));
  return {
    completedBlockIds,
    cachedBlockIds: completedBlockIds.filter((blockId) => cached.has(blockId)),
    translations: completedBlockIds.map((blockId) => completed.get(blockId)!),
    usage,
  };
  } finally {
    combinedSignal.cleanup();
  }
}
