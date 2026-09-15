import type { TypstProject } from './project';
import type { TypstRuntimePaths } from './runtimePaths';
import type { TypstWorkerPhase, TypstWorkerRequest, TypstWorkerResponse } from './messages';

export interface TypstCompileResult {
  pdf: Uint8Array;
  svg: string;
}

export interface TypstCompilerOptions {
  runtimePaths: TypstRuntimePaths;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?(phase: TypstWorkerPhase): void;
  workerFactory?: () => Worker;
}

function abortError(): DOMException {
  return new DOMException('Typst compilation stopped', 'AbortError');
}

function createCompilerWorker(): Worker {
  return new Worker(new URL('./compiler.worker.ts', import.meta.url), { type: 'module' });
}

export function compileTypstProject(
  project: TypstProject,
  options: TypstCompilerOptions,
): Promise<TypstCompileResult> {
  if (options.signal?.aborted) return Promise.reject(abortError());
  const worker = (options.workerFactory ?? createCompilerWorker)();
  const requestId = crypto.randomUUID();
  const request: TypstWorkerRequest = {
    type: 'compile',
    requestId,
    mainContent: project.mainContent,
    files: [...project.files].map(([path, bytes]) => ({ path, bytes })),
    runtimePaths: options.runtimePaths,
  };

  return new Promise<TypstCompileResult>((resolve, reject) => {
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      finish(() => reject(new DOMException('Typst compilation timed out', 'TimeoutError')));
    }, options.timeoutMs ?? 180_000);

    const cleanup = (): void => {
      globalThis.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', handleAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const handleAbort = (): void => finish(() => reject(abortError()));

    worker.onmessage = (event: MessageEvent<TypstWorkerResponse>) => {
      const response = event.data;
      if (response.requestId !== requestId) return;
      if (response.type === 'progress') {
        options.onProgress?.(response.phase);
        return;
      }
      if (response.type === 'error') {
        finish(() => reject(new Error(response.message.slice(0, 500))));
        return;
      }
      finish(() => resolve({ pdf: response.pdf, svg: response.svg }));
    };
    worker.onerror = (event: ErrorEvent) => {
      finish(() => reject(new Error(event.message || 'Typst worker failed')));
    };
    options.signal?.addEventListener('abort', handleAbort, { once: true });
    worker.postMessage(request);
  });
}
