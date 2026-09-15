// DeepSeek's API alias points to DeepSeek-V4.1-Flash for text and images.
export const DEEPSEEK_FLASH_MODEL_ID = 'deepseek-flash' as const;
export const DEEPSEEK_FLASH_MODEL_LABEL = 'DeepSeek V4.1 Flash' as const;

export type DeepSeekModelId = typeof DEEPSEEK_FLASH_MODEL_ID | 'deepseek-v4-pro';

export interface DeepSeekModel {
  id: DeepSeekModelId;
  label: typeof DEEPSEEK_FLASH_MODEL_LABEL | 'DeepSeek V4 Pro';
}

export const CURRENT_DEEPSEEK_MODELS: readonly DeepSeekModel[] = [
  { id: DEEPSEEK_FLASH_MODEL_ID, label: DEEPSEEK_FLASH_MODEL_LABEL },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
];

export function normalizeDeepSeekModelId(modelId: string): string {
  return modelId === 'deepseek-v4-flash' || modelId === 'deepseek-v4-flash-vision-exp'
    ? DEEPSEEK_FLASH_MODEL_ID
    : modelId;
}

// Upgrade settings when a task runs; leave completed artifacts and cache keys
// intact so old output is never relabeled as newly generated V4.1 output.
export function normalizeDeepSeekTaskSettings<T extends { modelId: string; visionModelId?: string }>(settings: T) {
  return {
    ...settings,
    modelId: normalizeDeepSeekModelId(settings.modelId),
    visionModelId: normalizeDeepSeekModelId(settings.visionModelId ?? DEEPSEEK_FLASH_MODEL_ID),
  };
}
