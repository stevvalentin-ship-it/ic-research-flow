import type { TypstRuntimePaths } from './runtimePaths';

export type TypstWorkerPhase = 'initializing' | 'mapping-files' | 'compiling-pdf' | 'rendering-preview';

export interface TypstWorkerRequest {
  type: 'compile';
  requestId: string;
  mainContent: string;
  files: Array<{ path: string; bytes: Uint8Array }>;
  runtimePaths: TypstRuntimePaths;
}

export type TypstWorkerResponse =
  | { type: 'progress'; requestId: string; phase: TypstWorkerPhase }
  | { type: 'done'; requestId: string; pdf: Uint8Array; svg: string }
  | { type: 'error'; requestId: string; message: string };
