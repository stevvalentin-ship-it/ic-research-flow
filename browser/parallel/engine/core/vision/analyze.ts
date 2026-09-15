import {
  chatCompletion,
  isNonRetryableDeepSeekAccountError,
  type ChatCompletionOptions,
  type ChatCompletionResult,
} from '../translate/client';
import {
  buildAcceptedPagePlanCacheKey,
  buildRawVisionResponseCacheKey,
  buildRecoveredPagePlanCacheKey,
  buildVisionLayoutCacheKey,
  type VisionPlanCacheIdentity,
} from '../project/cacheKey';
import {
  parseVisionPageAnalysis,
  VisionProtocolError,
  type VisionPageAnalysis,
} from './protocol';
import { buildVisionLayoutPrompt, VISION_LAYOUT_PROMPT_VERSION } from './prompts';
import {
  PdfPageRenderTimeoutError,
  renderPdfPageAsPng,
  type PdfPageForVision,
  type RenderPdfPageOptions,
} from './render';
import {
  createVisionPagePlan,
  parseCachedVisionPagePlan,
  planToVisionAnalysis,
  VISION_PLAN_CANONICALIZATION_VERSION,
  type VisionPagePlan,
} from './pagePlan';
import { verifyVisionPagePlan } from './planVerifier';
import { RecoverablePipelineError } from '../task/recoverable';
import { CachePersistenceError, persistCacheRecord } from '../project/cacheErrors';
import { REQUIRED_VISION_MODEL_ID } from './model';

export const VISION_LAYOUT_MODEL = REQUIRED_VISION_MODEL_ID;
export const VISION_RENDER_VERSION = 'pdfjs-2x-white-v1';
export const VISION_LAYOUT_RENDER_SCALE = 2;
export const VISION_LAYOUT_FALLBACK_RENDER_SCALE = 1.25;
export const VISION_LAYOUT_LAST_RESORT_RENDER_SCALE = 0.8;
export const VISION_LAYOUT_RENDER_TIMEOUT_MS = 30_000;
export const VISION_LAYOUT_REQUEST_ATTEMPTS = 2;
export const VISION_PAGE_PLAN_PROTOCOL_VERSION = 'vision-page-plan-v1';
export const VISION_LAYOUT_PARSER_VERSION = 'vision-layout-parser-v5';
export const VISION_LAYOUT_VERIFIER_VERSION = 'vision-plan-verifier-v1';
export const VISION_LAYOUT_RECOVERY_VERSION = 'vision-plan-recovery-v6';

export interface VisionRawResponseRecord {
  schemaVersion: 1;
  pageIndex: number;
  attempt: number;
  receivedAt: number;
  content: string;
  usage: ChatCompletionResult['usage'];
}

export interface PdfDocumentForVision {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageForVision>;
}

export interface AnalyzePdfLayoutOptions {
  pdf: PdfDocumentForVision;
  baseUrl: string;
  apiKey: string;
  fileHash: string;
  signal?: AbortSignal;
  complete?: (options: ChatCompletionOptions) => Promise<ChatCompletionResult>;
  renderPage?: (page: PdfPageForVision, options?: RenderPdfPageOptions) => Promise<string>;
  loadCached?(key: string, pageIndex: number): Promise<unknown | undefined>;
  loadAccepted?(key: string, pageIndex: number): Promise<unknown | undefined>;
  loadRecovered?(key: string, pageIndex: number): Promise<unknown | undefined>;
  saveCached?(key: string, pageIndex: number, analysis: VisionPageAnalysis): Promise<void>;
  saveRaw?(key: string, pageIndex: number, response: VisionRawResponseRecord): Promise<void>;
  saveRecovered?(key: string, pageIndex: number, plan: VisionPagePlan): Promise<void>;
  onPlan?(event: { pageIndex: number; plan: VisionPagePlan; cached: boolean }): void;
  onPageStart?(event: { pageIndex: number; totalPages: number }): void;
  onPagePhase?(event: {
    pageIndex: number;
    totalPages: number;
    phase: 'render-retrying' | 'analysis-retrying' | 'analysis-paused';
  }): void;
  onPage?(event: {
    pageIndex: number; totalPages: number; cached: boolean;
    networkAttempts: number; promptTokens: number; completionTokens: number;
  }): void;
}

export const VISION_LAYOUT_CONCURRENCY = 2;

function renderedPageFingerprint(imageUrl: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < imageUrl.length; index += 1) {
    hash ^= imageUrl.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `render-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export async function analyzePdfLayoutWithVision(options: AnalyzePdfLayoutOptions): Promise<VisionPageAnalysis[]> {
  if (!options.apiKey.trim()) throw new Error('V4.1 Flash 版式识别需要 DeepSeek API Key');
  const taskController = new AbortController();
  const abortFromCaller = (): void => taskController.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const taskSignal = taskController.signal;
  try {
  const complete = options.complete ?? chatCompletion;
  const renderPage = options.renderPage ?? ((page, renderOptions) => renderPdfPageAsPng(page, renderOptions));
  const results: VisionPageAnalysis[] = Array.from({ length: options.pdf.numPages });
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  // PDF.js can stall when multiple large page canvases are rasterized at once,
  // especially after several pages. Keep rasterization serial while allowing the
  // two Vision API requests to overlap after their images have been produced.
  let renderTail = Promise.resolve();
  const serializeRender = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = renderTail;
    let release!: () => void;
    renderTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const renderLayoutPage = async (pageIndex: number): Promise<{ imageUrl: string; renderScale: number }> => serializeRender(async () => {
    const renderAttempt = async (scale: number): Promise<string> => {
      if (taskSignal.aborted) throw new DOMException('已停止', 'AbortError');
      const page = await options.pdf.getPage(pageIndex + 1);
      try {
        return await renderPage(page, {
          scale,
          signal: taskSignal,
          timeoutMs: VISION_LAYOUT_RENDER_TIMEOUT_MS,
        });
      } finally {
        try { page.cleanup?.(); } catch { /* release is best-effort */ }
      }
    };

    const scales = [
      VISION_LAYOUT_RENDER_SCALE,
      VISION_LAYOUT_FALLBACK_RENDER_SCALE,
      VISION_LAYOUT_LAST_RESORT_RENDER_SCALE,
    ];
    for (const [index, scale] of scales.entries()) {
      try {
        return { imageUrl: await renderAttempt(scale), renderScale: scale };
      } catch (error) {
        if (!(error instanceof PdfPageRenderTimeoutError) || taskSignal.aborted) throw error;
        if (index === scales.length - 1) break;
        options.onPagePhase?.({
          pageIndex,
          totalPages: options.pdf.numPages,
          phase: 'render-retrying',
        });
      }
    }
    throw new RecoverablePipelineError(
      'render-retries-exhausted',
      `第 ${pageIndex + 1} 页连续渲染超时，任务已暂停，可稍后继续`,
      {
        phase: 'initial-analysis', pageIndex, totalPages: options.pdf.numPages,
        correctionRound: 0, remainingPageRounds: 2, validatedPages: results.filter(Boolean).length,
        failedPages: [pageIndex], cachedPages: 0, correctionCallsUsed: 0,
        maxCorrectionCalls: 0, promptTokens: 0, completionTokens: 0,
        errorCode: 'transient.render-retries-exhausted', errorMessage: '页面连续渲染超时',
      },
    );
  });

  const analyzePage = async (pageIndex: number): Promise<void> => {
    if (taskSignal.aborted) throw new DOMException('已停止', 'AbortError');
    const legacyCacheKey = buildVisionLayoutCacheKey({
      fileHash: options.fileHash,
      pageIndex,
      modelId: VISION_LAYOUT_MODEL,
      promptVersion: VISION_LAYOUT_PROMPT_VERSION,
      renderVersion: VISION_RENDER_VERSION,
    });
    const cacheIdentityForScale = (renderScale: number): VisionPlanCacheIdentity => ({
      fileHash: options.fileHash,
      pageIndex,
      modelId: VISION_LAYOUT_MODEL,
      promptVersion: VISION_LAYOUT_PROMPT_VERSION,
      renderVersion: VISION_RENDER_VERSION,
      renderScale,
      protocolVersion: VISION_PAGE_PLAN_PROTOCOL_VERSION,
      parserVersion: VISION_LAYOUT_PARSER_VERSION,
      verifierVersion: VISION_LAYOUT_VERIFIER_VERSION,
      recoveryVersion: VISION_LAYOUT_RECOVERY_VERSION,
      canonicalizationVersion: VISION_PLAN_CANONICALIZATION_VERSION,
      round: 0,
    });
    for (const renderScale of [
      VISION_LAYOUT_RENDER_SCALE,
      VISION_LAYOUT_FALLBACK_RENDER_SCALE,
      VISION_LAYOUT_LAST_RESORT_RENDER_SCALE,
    ]) {
      try {
        const accepted = await options.loadAccepted?.(
          buildAcceptedPagePlanCacheKey(cacheIdentityForScale(renderScale)), pageIndex,
        );
        if (accepted !== undefined) {
          const plan = parseCachedVisionPagePlan(accepted, pageIndex);
          if (plan.renderScale !== renderScale
            || verifyVisionPagePlan(plan).some((issue) => issue.severity === 'error')) {
            throw new Error('accepted page plan no longer passes cache identity or protocol verification');
          }
          results[pageIndex] = planToVisionAnalysis(plan);
          options.onPlan?.({ pageIndex, plan, cached: true });
          options.onPage?.({
            pageIndex, totalPages: options.pdf.numPages, cached: true,
            networkAttempts: 0, promptTokens: 0, completionTokens: 0,
          });
          return;
        }
      } catch {
        // Corrupt or obsolete accepted plans are cache misses. Try the next
        // supported render identity before falling back to legacy migration.
      }
    }
    for (const renderScale of [
      VISION_LAYOUT_RENDER_SCALE,
      VISION_LAYOUT_FALLBACK_RENDER_SCALE,
      VISION_LAYOUT_LAST_RESORT_RENDER_SCALE,
    ]) {
      try {
        const recovered = await options.loadRecovered?.(
          buildRecoveredPagePlanCacheKey(cacheIdentityForScale(renderScale)), pageIndex,
        );
        if (recovered !== undefined) {
          const plan = parseCachedVisionPagePlan(recovered, pageIndex);
          if (plan.renderScale !== renderScale
            || plan.origin !== 'initial'
            || verifyVisionPagePlan(plan).some((issue) => issue.severity === 'error')) {
            throw new Error('recovered page plan no longer passes cache identity or protocol verification');
          }
          results[pageIndex] = planToVisionAnalysis(plan);
          options.onPlan?.({ pageIndex, plan, cached: true });
          options.onPage?.({
            pageIndex, totalPages: options.pdf.numPages, cached: true,
            networkAttempts: 0, promptTokens: 0, completionTokens: 0,
          });
          return;
        }
      } catch {
        // A protocol-valid initial plan can be resumed before document-level
        // reconciliation. Corrupt or stale records remain ordinary misses.
      }
    }
    let cached: unknown | undefined;
    try {
      cached = await options.loadCached?.(legacyCacheKey, pageIndex);
    } catch {
      cached = undefined;
    }
    if (cached !== undefined) {
      try {
        const analysis = parseVisionPageAnalysis(cached, pageIndex);
        const plan = createVisionPagePlan({
          analysis,
          renderFingerprint: `legacy-cache-p${pageIndex + 1}`,
        });
        results[pageIndex] = planToVisionAnalysis(plan);
        options.onPlan?.({ pageIndex, plan, cached: true });
        options.onPage?.({
          pageIndex, totalPages: options.pdf.numPages, cached: true,
          networkAttempts: 0, promptTokens: 0, completionTokens: 0,
        });
        return;
      } catch {
        // A partial write, an older schema, or manual storage corruption must
        // behave like a cache miss. The validated fresh result below replaces
        // the bad record through saveCached.
      }
    }

    options.onPageStart?.({ pageIndex, totalPages: options.pdf.numPages });
    const { imageUrl, renderScale } = await renderLayoutPage(pageIndex);
    const cacheIdentity = cacheIdentityForScale(renderScale);
    const renderFingerprint = renderedPageFingerprint(imageUrl);
    let lastError: unknown;
    let pagePromptTokens = 0;
    let pageCompletionTokens = 0;
    for (let attempt = 1; attempt <= VISION_LAYOUT_REQUEST_ATTEMPTS; attempt += 1) {
      try {
        const retryInstruction = attempt === 1
          ? ''
          : '\nThe preceding response was invalid. Return only the exact JSON object requested; no explanation, prefix, suffix, or Markdown.';
        const completion = await complete({
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          model: VISION_LAYOUT_MODEL,
          thinkingMode: 'disabled',
          responseFormat: 'json_object',
          maxTokens: 2_048,
          timeoutMs: 90_000,
          signal: taskSignal,
          messages: [{ role: 'user', content: [
            { type: 'text', text: `${buildVisionLayoutPrompt(pageIndex + 1)}${retryInstruction}` },
            { type: 'image_url', image_url: { url: imageUrl, detail: 'original' } },
          ] }],
        });
        if (taskSignal.aborted) throw new DOMException('已停止', 'AbortError');
        pagePromptTokens += completion.usage.promptTokens;
        pageCompletionTokens += completion.usage.completionTokens;
        totalPromptTokens += completion.usage.promptTokens;
        totalCompletionTokens += completion.usage.completionTokens;
        await persistCacheRecord('Vision 原始响应缓存', options.saveRaw ? () => options.saveRaw!(
          `${buildRawVisionResponseCacheKey(cacheIdentity)}:attempt-${attempt}`, pageIndex, {
            schemaVersion: 1,
            pageIndex,
            attempt,
            receivedAt: Date.now(),
            content: completion.content,
            usage: completion.usage,
          },
        ) : undefined);
        const analysis = parseVisionPageAnalysis(completion.content, pageIndex);
        const plan = createVisionPagePlan({ analysis, renderFingerprint, renderScale });
        const planIssues = verifyVisionPagePlan(plan).filter((issue) => issue.severity === 'error');
        if (planIssues.length) throw new VisionProtocolError(
          `页面计划未通过协议门禁：${planIssues.map((issue) => issue.code).join(', ')}`,
        );
        if (options.saveRecovered) {
          await persistCacheRecord('Vision 恢复计划缓存', () => options.saveRecovered!(
            buildRecoveredPagePlanCacheKey(cacheIdentity), pageIndex, plan,
          ));
        } else {
          await persistCacheRecord('Vision 兼容缓存', options.saveCached ? () => options.saveCached!(
            legacyCacheKey, pageIndex, planToVisionAnalysis(plan),
          ) : undefined);
        }
        results[pageIndex] = planToVisionAnalysis(plan);
        options.onPlan?.({ pageIndex, plan, cached: false });
        options.onPage?.({
          pageIndex, totalPages: options.pdf.numPages, cached: false,
          networkAttempts: attempt,
          promptTokens: pagePromptTokens,
          completionTokens: pageCompletionTokens,
        });
        return;
      } catch (error) {
        if (taskSignal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        if (error instanceof CachePersistenceError) throw error;
        if (isNonRetryableDeepSeekAccountError(error)) throw error;
        lastError = error;
        if (attempt < VISION_LAYOUT_REQUEST_ATTEMPTS) {
          options.onPagePhase?.({
            pageIndex,
            totalPages: options.pdf.numPages,
            phase: 'analysis-retrying',
          });
        }
      }
    }

    options.onPagePhase?.({
      pageIndex,
      totalPages: options.pdf.numPages,
      phase: 'analysis-paused',
    });
    const protocolFailure = lastError instanceof VisionProtocolError;
    throw new RecoverablePipelineError(
      protocolFailure ? 'vision-protocol-retries-exhausted' : 'network-retries-exhausted',
      `第 ${pageIndex + 1} 页 Vision ${protocolFailure ? '响应协议' : '网络请求'}连续失败，任务已暂停`,
      {
        phase: 'initial-analysis', pageIndex, totalPages: options.pdf.numPages,
        correctionRound: 0, remainingPageRounds: 2, validatedPages: results.filter(Boolean).length,
        failedPages: [pageIndex], cachedPages: 0, correctionCallsUsed: 0,
        maxCorrectionCalls: 0, promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens,
        errorCode: protocolFailure
          ? 'transient.vision-protocol-retries-exhausted'
          : 'transient.network-retries-exhausted',
        errorMessage: protocolFailure ? 'Vision 响应协议连续失败' : 'Vision 网络请求连续失败',
      },
    );
  };

  let nextPageIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextPageIndex < options.pdf.numPages) {
      const pageIndex = nextPageIndex;
      nextPageIndex += 1;
      await analyzePage(pageIndex);
    }
  };
  let firstWorkerError: unknown;
  const guardedWorker = async (): Promise<void> => {
    try {
      await worker();
    } catch (error) {
      if (firstWorkerError === undefined) firstWorkerError = error;
      taskController.abort(error);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(VISION_LAYOUT_CONCURRENCY, options.pdf.numPages) },
    () => guardedWorker(),
  ));
  if (options.signal?.aborted) {
    throw new DOMException('已停止', 'AbortError');
  }
  if (firstWorkerError !== undefined) throw firstWorkerError;
  return results;
  } finally {
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}
