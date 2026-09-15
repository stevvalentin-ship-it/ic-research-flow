export interface AsyncDeadlineOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutMessage?: string;
  /** Best-effort cancellation of the underlying operation; never delays rejection. */
  onCancel?(): void;
}

export class AsyncOperationTimeoutError extends Error {
  constructor(message = '操作等待超时') {
    super(message);
    this.name = 'AsyncOperationTimeoutError';
  }
}

/** Settle the caller even when a third-party operation ignores cancellation. */
export function awaitWithDeadline<T>(operation: PromiseLike<T>, options: AsyncDeadlineOptions = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (failed: boolean, value?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (failed) reject(value);
      else resolve(value as T);
    };
    const cancel = (error: Error): void => {
      if (settled) return;
      finish(true, error);
      try { options.onCancel?.(); } catch { /* Cancellation must not hide the terminal error. */ }
    };
    const abort = (): void => cancel(new DOMException('任务已停止', 'AbortError'));
    // Always consume late completion/rejection, including an already-aborted signal.
    Promise.resolve(operation).then((result) => finish(false, result), (error) => finish(true, error));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    } else if (options.timeoutMs !== undefined) {
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
        finish(true, new RangeError('timeoutMs must be a positive finite number'));
        return;
      }
      timer = setTimeout(() => cancel(new AsyncOperationTimeoutError(options.timeoutMessage)), options.timeoutMs);
    }
  });
}
