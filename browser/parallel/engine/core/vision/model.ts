import { DEEPSEEK_FLASH_MODEL_ID, DEEPSEEK_FLASH_MODEL_LABEL } from '../translate/models';

/**
 * Formal source-layout analysis and final PDF review are intentionally pinned
 * to one verified multimodal model.  The user-selected model remains a text
 * translation concern and must never silently change this quality boundary.
 */
export const REQUIRED_VISION_MODEL_ID = DEEPSEEK_FLASH_MODEL_ID;
export const REQUIRED_VISION_MODEL_LABEL = DEEPSEEK_FLASH_MODEL_LABEL;
