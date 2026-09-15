import type { TaskSnapshot } from '../../types/models';

export type TaskEvent =
  | { type: 'START_PARSE'; at: number }
  | { type: 'PARSE_DONE'; at: number }
  | { type: 'LAYOUT_DONE'; at: number }
  | { type: 'GLOSSARY_DONE'; at: number }
  | { type: 'START_TRANSLATION'; total: number; at: number }
  | { type: 'BLOCKS_VALIDATED'; count: number; at: number }
  | { type: 'TRANSLATION_DONE'; at: number }
  | { type: 'COMPOSITION_DONE'; at: number }
  | { type: 'COMPILE_DONE'; at: number }
  | { type: 'ALIGNMENT_DONE'; at: number }
  | { type: 'QUALITY_STARTED'; at: number }
  | { type: 'PAUSED'; reason: NonNullable<TaskSnapshot['pauseReason']>; error: string; at: number }
  | { type: 'STOP_REQUESTED'; at: number }
  | { type: 'STOPPED'; at: number }
  | { type: 'INTERRUPTED'; at: number }
  | { type: 'RESUME'; at: number }
  | { type: 'FAILED'; error: string; at: number }
  | { type: 'QUALITY_PASSED'; at: number };

export function createTaskSnapshot(projectId: string, at = Date.now()): TaskSnapshot {
  return {
    projectId,
    stage: 'idle',
    status: 'idle',
    progress: { completed: 0, total: 0, retries: 0, failed: 0 },
    createdAt: at,
    updatedAt: at,
  };
}

export function reduceTaskEvent(state: TaskSnapshot, event: TaskEvent): TaskSnapshot {
  if (event.type === 'START_PARSE' && state.stage === 'idle') {
    return {
      ...state,
      stage: 'parsing',
      status: 'running',
      startedAt: event.at,
      updatedAt: event.at,
    };
  }

  if (event.type === 'PARSE_DONE' && state.stage === 'parsing') {
    return { ...state, stage: 'analyzing-layout', updatedAt: event.at };
  }

  if (event.type === 'LAYOUT_DONE' && state.stage === 'analyzing-layout') {
    return { ...state, stage: 'building-glossary', updatedAt: event.at };
  }

  if (event.type === 'GLOSSARY_DONE' && state.stage === 'building-glossary') {
    return { ...state, stage: 'translating', updatedAt: event.at };
  }

  if (event.type === 'START_TRANSLATION') {
    return {
      ...state,
      stage: 'translating',
      status: 'running',
      progress: { completed: 0, total: event.total, retries: 0, failed: 0 },
      startedAt: state.startedAt ?? event.at,
      updatedAt: event.at,
    };
  }

  if (event.type === 'BLOCKS_VALIDATED' && state.stage === 'translating') {
    if (state.progress.completed + event.count > state.progress.total) {
      throw new Error('Validated block count exceeds the translation total');
    }
    return {
      ...state,
      progress: { ...state.progress, completed: state.progress.completed + event.count },
      updatedAt: event.at,
    };
  }

  if (event.type === 'TRANSLATION_DONE' && state.stage === 'translating') {
    if (state.progress.completed !== state.progress.total || state.progress.failed !== 0) {
      throw new Error('Translation cannot complete with pending or failed blocks');
    }
    return { ...state, stage: 'composing', updatedAt: event.at };
  }

  if (event.type === 'COMPOSITION_DONE' && state.stage === 'composing') {
    return { ...state, stage: 'compiling', updatedAt: event.at };
  }

  if (event.type === 'COMPILE_DONE' && state.stage === 'compiling') {
    return { ...state, stage: 'aligning', updatedAt: event.at };
  }

  if (event.type === 'ALIGNMENT_DONE' && state.stage === 'aligning') {
    return { ...state, updatedAt: event.at };
  }

  if (event.type === 'QUALITY_STARTED' && state.stage === 'aligning') {
    return { ...state, stage: 'validating', updatedAt: event.at };
  }

  if (event.type === 'PAUSED' && (state.status === 'running' || state.status === 'pausing')) {
    return {
      ...state,
      status: 'paused',
      pauseReason: event.reason,
      error: event.error,
      updatedAt: event.at,
    };
  }

  if (event.type === 'STOP_REQUESTED' && state.status === 'running') {
    return { ...state, status: 'stopping', updatedAt: event.at };
  }

  if (event.type === 'STOPPED' && state.status === 'stopping') {
    return { ...state, status: 'stopped', updatedAt: event.at };
  }

  if (event.type === 'INTERRUPTED' && ['running', 'stopping', 'pausing'].includes(state.status)) {
    return { ...state, status: 'stopped', updatedAt: event.at };
  }

  if (event.type === 'RESUME' && (state.status === 'stopped' || state.status === 'paused' || state.status === 'failed')) {
    return { ...state, status: 'running', error: undefined, pauseReason: undefined, updatedAt: event.at };
  }

  if (event.type === 'FAILED') {
    return { ...state, status: 'failed', error: event.error, pauseReason: undefined, updatedAt: event.at };
  }

  if (event.type === 'QUALITY_PASSED' && state.stage === 'validating') {
    return { ...state, stage: 'completed', status: 'completed', updatedAt: event.at };
  }

  throw new Error(`${event.type} is invalid from ${state.stage}`);
}
