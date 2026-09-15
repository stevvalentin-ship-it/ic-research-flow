import type { TaskSnapshot } from '../../types/models';

export const CURRENT_LAYOUT_PROFILE = 'zh-single-column-v1' as const;
export const CURRENT_TARGET_LAYOUT_POLICY = 'single-column' as const;

export function usesCurrentSingleColumnLayout(task: Pick<TaskSnapshot, 'settings'> | undefined): boolean {
  return task?.settings?.targetLayoutPolicy === CURRENT_TARGET_LAYOUT_POLICY
    && task.settings.layoutProfileVersion === CURRENT_LAYOUT_PROFILE;
}

export function resetTaskForSingleColumnLayout(task: TaskSnapshot, at = Date.now()): TaskSnapshot {
  if (!task.settings) throw new Error('任务缺少模型与源文件设置');
  const { maxVisionCorrectionCalls: _staleCorrectionBudget, ...settings } = task.settings;
  return {
    ...task,
    stage: 'idle',
    status: 'idle',
    progress: { completed: 0, total: 0, retries: 0, failed: 0 },
    startedAt: undefined,
    updatedAt: at,
    error: undefined,
    pauseReason: undefined,
    visionAttempt: undefined,
    settings: {
      ...settings,
      targetLayoutPolicy: CURRENT_TARGET_LAYOUT_POLICY,
      layoutProfileVersion: CURRENT_LAYOUT_PROFILE,
    },
  };
}
