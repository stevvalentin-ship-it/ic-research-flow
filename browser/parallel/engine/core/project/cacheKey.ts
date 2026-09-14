export interface TranslationCacheIdentity {
  fileHash: string;
  promptVersion: string;
  modelId: string;
  thinkingMode: 'enabled' | 'disabled';
  glossaryHash: string;
  blockId: string;
  sourceText: string;
  protectedTokens?: readonly string[];
}

const TRANSLATION_CACHE_VERSION = 'translation-cache-v2';

function encodeCacheComponent(value: string): string {
  let wellFormed = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        wellFormed += value[index] + value[index + 1];
        index += 1;
      } else {
        wellFormed += '\uFFFD';
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      wellFormed += '\uFFFD';
    } else {
      wellFormed += value[index];
    }
  }
  return encodeURIComponent(wellFormed);
}

export function buildTranslationCacheKey(value: TranslationCacheIdentity): string {
  const parts = [
    // Invalidate responses produced before protected-number matching learned
    // to recognize numerals adjacent to Chinese text and hyphenated IDs.
    // Those cached responses can contain deterministic repair suffixes such
    // as `图 11 11` or `3.9 倍 3.9` even though the API translation was sound.
    TRANSLATION_CACHE_VERSION,
    value.fileHash,
    value.promptVersion,
    value.modelId,
    value.thinkingMode,
    value.glossaryHash,
    value.blockId,
    value.sourceText,
  ];
  if (value.protectedTokens?.length) parts.push(JSON.stringify(value.protectedTokens));
  return parts
    .map(encodeCacheComponent)
    .join(':');
}

export interface VisionLayoutCacheIdentity {
  fileHash: string;
  pageIndex: number;
  modelId: string;
  promptVersion: string;
  renderVersion: string;
  renderScale?: number;
  protocolVersion?: string;
  parserVersion?: string;
  verifierVersion?: string;
  recoveryVersion?: string;
  canonicalizationVersion?: string;
}

export function buildVisionLayoutCacheKey(value: VisionLayoutCacheIdentity): string {
  return [
    'vision-layout',
    value.fileHash,
    String(value.pageIndex),
    value.modelId,
    value.promptVersion,
    value.renderVersion,
  ].map(encodeCacheComponent).join(':');
}

export interface VisionPlanCacheIdentity extends VisionLayoutCacheIdentity {
  round: 0 | 1 | 2;
  basePlanDigest?: string;
  validationErrorDigest?: string;
}

function visionPlanCacheParts(prefix: string, value: VisionPlanCacheIdentity): string[] {
  return [
    prefix,
    value.fileHash,
    String(value.pageIndex),
    value.modelId,
    value.promptVersion,
    value.renderVersion,
    String(value.renderScale ?? 2),
    value.protocolVersion ?? 'vision-page-plan-v1',
    value.parserVersion ?? 'pdfjs-parser-v1',
    value.verifierVersion ?? 'vision-plan-verifier-v1',
    value.recoveryVersion ?? 'vision-plan-recovery-v4',
    value.canonicalizationVersion ?? 'vision-plan-c14n-v2',
    String(value.round),
    value.basePlanDigest ?? 'none',
    value.validationErrorDigest ?? 'none',
  ];
}

function buildVisionPlanCacheKey(prefix: string, value: VisionPlanCacheIdentity): string {
  return visionPlanCacheParts(prefix, value).map(encodeCacheComponent).join(':');
}

export function buildRawVisionResponseCacheKey(value: VisionPlanCacheIdentity): string {
  return buildVisionPlanCacheKey('raw-vision-response', value);
}

export function buildVisionCorrectionPatchCacheKey(value: VisionPlanCacheIdentity): string {
  return buildVisionPlanCacheKey('vision-correction-patch', value);
}

export function buildRecoveredPagePlanCacheKey(value: VisionPlanCacheIdentity): string {
  return buildVisionPlanCacheKey('recovered-page-plan', value);
}

export function buildAcceptedPagePlanCacheKey(value: VisionPlanCacheIdentity): string {
  return buildVisionPlanCacheKey('accepted-page-plan', value);
}

export interface FormulaOcrCacheIdentity {
  fileHash: string;
  pageIndex: number;
  regionId: string;
  modelId: string;
  promptVersion: string;
  sourceRect: string;
}

export function buildFormulaOcrCacheKey(value: FormulaOcrCacheIdentity): string {
  return [
    'formula-ocr',
    value.fileHash,
    String(value.pageIndex),
    value.regionId,
    value.modelId,
    value.promptVersion,
    value.sourceRect,
  ].map(encodeCacheComponent).join(':');
}
