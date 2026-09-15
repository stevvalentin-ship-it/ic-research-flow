import type { AlignmentManifest } from '../align/manifest';
import {
  chatCompletion,
  isRetryableDeepSeekTransportError,
  type ChatCompletionOptions,
  type ChatCompletionResult,
} from '../translate/client';
import { buildVisionFinalConfirmationPrompt, buildVisionFinalReviewPrompt } from './prompts';
import {
  PdfPageRenderTimeoutError,
  renderPdfPageAsPng,
  type PdfPageForVision,
} from './render';
import { VISION_LAYOUT_MODEL, type PdfDocumentForVision } from './analyze';
import { parseNormalizedVisionBox } from './protocol';
import type { TargetLayoutPolicy } from '../typst/template';

export type VisionFinalIssueType =
  | 'missing_text' | 'clipped_text' | 'overlap' | 'unreadable_glyphs'
  | 'untranslated_body' | 'layout_collapse' | 'layout_drift'
  | 'asset_changed' | 'asset_missing' | 'formula_changed' | 'table_changed'
  | 'review_incomplete';

export interface VisionFinalIssue {
  targetPageIndex: number;
  type: VisionFinalIssueType;
  severity: 'severe' | 'warning';
  bbox: [number, number, number, number];
  confidence: number;
  evidence: string;
}

export interface VisionFinalPageReport {
  targetPageIndex: number;
  pass: boolean;
  issues: VisionFinalIssue[];
}

export interface VisionFinalReport {
  pass: boolean;
  issues: VisionFinalIssue[];
  reviewedPages: number;
}

function rootObject(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    try {
      parsed = JSON.parse(fenced ? fenced[1] : trimmed);
    } catch {
      throw new Error('Vision 成品质检 JSON 无法解析');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Vision 成品质检 JSON 必须为对象');
  return parsed as Record<string, unknown>;
}

const ISSUE_TYPES: readonly VisionFinalIssueType[] = [
  'missing_text', 'clipped_text', 'overlap', 'unreadable_glyphs', 'untranslated_body',
  'layout_collapse', 'layout_drift', 'asset_changed', 'asset_missing', 'formula_changed', 'table_changed',
];

const AUTHOR_PORTRAIT_EVIDENCE = /\b(?:author\s+)?(?:portrait|headshot|photo)s?\b|头像|肖像/i;

function isAuthorPortraitMissing(issue: Pick<VisionFinalIssue, 'type' | 'evidence'>): boolean {
  return issue.type === 'asset_missing' && AUTHOR_PORTRAIT_EVIDENCE.test(issue.evidence);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allow.has(key));
  if (unknown) throw new Error(`Vision 成品质检 ${path} 包含不允许字段 ${unknown}`);
}

function calibratedSeverity(
  type: VisionFinalIssueType,
  severity: VisionFinalIssue['severity'],
  confidence: number,
  evidence: string,
): VisionFinalIssue['severity'] {
  // Page-local absence is not proof of document-wide loss after natural
  // repagination. Every translated segment and immutable asset has already
  // passed the global marker/content/hash gates before this review. Keep the
  // model's missing-text/asset observations as useful warnings, while visible
  // clipping, overlap, corruption and changed assets remain blocking.
  if (type === 'asset_missing') {
    // Page-local movement is common for numbered figures and tables, but
    // author portraits/headshots are uncaptioned assets that otherwise have
    // no deterministic text marker. Missing them anywhere in the final author
    // section is a real document-level loss and must remain blocking.
    if (AUTHOR_PORTRAIT_EVIDENCE.test(evidence)
      && confidence >= 0.85) return 'severe';
    return 'warning';
  }
  if (type === 'missing_text') return 'warning';
  if (severity === 'severe') return severity;
  if (confidence >= 0.7
    && (type === 'overlap' || type === 'clipped_text' || type === 'untranslated_body')) return 'severe';
  if (confidence >= 0.8
    && (type === 'asset_changed' || type === 'formula_changed' || type === 'table_changed')) return 'severe';
  if (type === 'unreadable_glyphs' && confidence >= 0.6
    && /(?:garbled|乱码|unclear symbols?|corrupt(?:ed)? glyph)/i.test(evidence)) return 'severe';
  if (type === 'layout_drift'
    && confidence >= 0.7
    && /(?:isolated|orphan|scattered|stray|garbled|mixed\s+(?:with|into)\s+(?:the\s+)?body|author.*body|caption.*overlap|孤立|散落|乱码|游离|作者单位.*正文混排|正文混排|题注.*重叠)/i.test(evidence)) return 'severe';
  if (confidence < 0.85) return severity;
  if (type === 'unreadable_glyphs') return 'severe';
  return severity;
}

export function isBlockingVisionFinalIssue(issue: VisionFinalIssue): boolean {
  if (issue.severity !== 'severe') return false;
  if (issue.confidence >= 0.8) return true;
  if (issue.confidence >= 0.7
    && (issue.type === 'overlap' || issue.type === 'clipped_text' || issue.type === 'untranslated_body'
      || (issue.type === 'layout_drift'
        && /(?:isolated|orphan|scattered|stray|mixed|overlap|孤立|散落|混排|重叠)/i.test(issue.evidence)))) return true;
  return issue.type === 'unreadable_glyphs'
    && issue.confidence >= 0.6
    && /(?:garbled|乱码|unclear symbols?|corrupt(?:ed)? glyph)/i.test(issue.evidence);
}

export function parseVisionFinalPageReport(value: unknown, expectedTargetPageIndex: number): VisionFinalPageReport {
  const root = rootObject(value);
  assertAllowedKeys(root, ['target_page', 'issues'], 'root');
  if (!Number.isInteger(root.target_page) || root.target_page !== expectedTargetPageIndex + 1) {
    throw new Error('Vision 成品质检 target_page 与请求页面不一致');
  }
  if (!Array.isArray(root.issues)) throw new Error('Vision 成品质检 issues 必须为数组');
  if (root.issues.length > 6) throw new Error('Vision 成品质检 issues 超过 6 个上限');
  const parsedIssues = root.issues.map((raw, index): VisionFinalIssue => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Vision 成品质检 issues[${index}] 必须为对象`);
    const item = raw as Record<string, unknown>;
    assertAllowedKeys(item, ['type', 'severity', 'bbox', 'confidence', 'evidence'], `issues[${index}]`);
    if (typeof item.type !== 'string' || !ISSUE_TYPES.includes(item.type as VisionFinalIssueType)) {
      throw new Error(`Vision 成品质检 issues[${index}].type 无效`);
    }
    if (item.severity !== 'severe' && item.severity !== 'warning') throw new Error(`Vision 成品质检 issues[${index}].severity 无效`);
    if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      throw new Error(`Vision 成品质检 issues[${index}].confidence 无效`);
    }
    if (item.evidence !== undefined && typeof item.evidence !== 'string') {
      throw new Error(`Vision 成品质检 issues[${index}].evidence 无效`);
    }
    const evidence = typeof item.evidence === 'string' && item.evidence.trim()
      ? item.evidence.trim().slice(0, 300)
      : `${item.type}（模型未提供说明）`;
    const bbox = parseNormalizedVisionBox(item.bbox, `issues[${index}].bbox`);
    return {
      targetPageIndex: expectedTargetPageIndex,
      type: item.type as VisionFinalIssueType,
      // Text markers, asset markers, content coverage and source hashes are
      // checked deterministically before this page review. With natural
      // repagination, source-page content can legitimately appear on an
      // adjacent target page, so a page-local "missing" guess must not veto
      // the whole document. Conversely,
      // high-confidence unreadable or visibly orphaned glyphs are production
      // defects even when the model undersells them as a warning.
      severity: calibratedSeverity(
        item.type as VisionFinalIssueType,
        item.severity,
        item.confidence,
        evidence,
      ),
      bbox,
      confidence: item.confidence,
      evidence,
    };
  });
  const seen = new Set<string>();
  const issues = parsedIssues.filter((issue) => {
    const key = `${issue.type}\u0000${issue.evidence.trim().toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    targetPageIndex: expectedTargetPageIndex,
    pass: !issues.some(isBlockingVisionFinalIssue),
    issues,
  };
}

export function buildTargetSourcePageMap(
  manifest: AlignmentManifest,
  targetPageCount: number,
  sourcePageCount: number,
): number[][] {
  return Array.from({ length: targetPageCount }, (_, targetPageIndex) => {
    const scores = new Map<number, number>();
    for (const unit of manifest.units) {
      const target = unit.target.find((set) => set.page === targetPageIndex);
      if (!target) continue;
      for (const source of unit.source) {
        scores.set(source.page, (scores.get(source.page) ?? 0) + Math.max(1, target.rects.length) * Math.max(1, source.rects.length));
      }
    }
    const ranked = [...scores.entries()]
      .filter(([page]) => page >= 0 && page < sourcePageCount)
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      // Natural Chinese repagination frequently combines the tail of one
      // source page with a figure/table from the next. Send the two dominant
      // source pages so Vision can detect a partially visible immutable asset
      // instead of comparing only the surrounding prose page.
      .slice(0, 2)
      .map(([page]) => page);
    if (ranked.length) return ranked;
    return [Math.min(sourcePageCount - 1, Math.floor(targetPageIndex / Math.max(1, targetPageCount) * sourcePageCount))];
  });
}

export interface RunVisionFinalReviewOptions {
  sourcePdf: PdfDocumentForVision;
  targetPdf: PdfDocumentForVision;
  manifest: AlignmentManifest;
  baseUrl: string;
  apiKey: string;
  targetLayoutPolicy?: TargetLayoutPolicy;
  signal?: AbortSignal;
  pageTimeoutMs?: number;
  complete?: (options: ChatCompletionOptions) => Promise<ChatCompletionResult>;
  renderPage?: (
    page: PdfPageForVision,
    role: 'source' | 'target',
    pageIndex: number,
    options?: { signal: AbortSignal; scale: number; timeoutMs: number },
  ) => Promise<string>;
  onPageStart?(event: { targetPageIndex: number; totalPages: number }): void;
  onPagePhase?(event: {
    targetPageIndex: number; totalPages: number;
    phase: 'render-retrying' | 'rendered' | 'connected' | 'content' | 'retrying' | 'returned';
  }): void;
  onPageInvalid?(event: { targetPageIndex: number; totalPages: number; reason: string }): void;
  onPageWait?(event: { targetPageIndex: number; totalPages: number; elapsedMs: number }): void;
  onPageTimeout?(event: { targetPageIndex: number; totalPages: number; timeoutMs: number }): void;
  onPage?(event: { targetPageIndex: number; totalPages: number; issueCount: number }): void;
}

export const VISION_FINAL_REVIEW_CONCURRENCY = 1;
export const VISION_FINAL_REVIEW_PAGE_TIMEOUT_MS = 300_000;
export const VISION_FINAL_REVIEW_RENDER_SCALE = 1.5;
export const VISION_FINAL_REVIEW_FALLBACK_RENDER_SCALE = 1;
export const VISION_FINAL_REVIEW_LAST_RESORT_RENDER_SCALE = 0.75;
export const VISION_FINAL_REVIEW_RENDER_TIMEOUT_MS = 30_000;

class VisionPageTimeoutError extends Error {
  constructor(pageIndex: number, totalPages: number, timeoutMs: number) {
    super(`V4.1 Flash 成品质检第 ${pageIndex + 1}/${totalPages} 页超过 ${Math.ceil(timeoutMs / 1_000)} 秒`);
    this.name = 'VisionPageTimeoutError';
  }
}

async function withPageDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  outerSignal: AbortSignal,
  pageIndex: number,
  totalPages: number,
  timeoutMs: number,
  onTimeout?: () => void,
  onWait?: (elapsedMs: number) => void,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutError = () => new VisionPageTimeoutError(pageIndex, totalPages, timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (outerSignal.aborted) controller.abort();
  else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  const startedAt = clock();
  let lastReportedWait = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setInterval(() => {
      const elapsedMs = clock() - startedAt;
      const waitBucket = Math.floor(elapsedMs / 15_000);
      if (waitBucket > lastReportedWait) {
        lastReportedWait = waitBucket;
        try { onWait?.(elapsedMs); } catch { /* diagnostics must never disable the watchdog */ }
      }
      if (elapsedMs < timeoutMs) return;
      timedOut = true;
      controller.abort();
      reject(timeoutError());
      try { onTimeout?.(); } catch { /* cancellation already happened */ }
    }, Math.min(1_000, Math.max(10, timeoutMs)));
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } catch (error) {
    if (timedOut) throw timeoutError();
    throw error;
  } finally {
    if (timer) clearInterval(timer);
    outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

export async function runVisionFinalReview(options: RunVisionFinalReviewOptions): Promise<VisionFinalReport> {
  if (!options.apiKey.trim()) throw new Error('V4.1 Flash 成品质检需要 DeepSeek API Key');
  const complete = options.complete ?? chatCompletion;
  const renderPage = options.renderPage
    ?? ((page, _role, _pageIndex, renderOptions) => renderPdfPageAsPng(page, {
      scale: renderOptions?.scale ?? VISION_FINAL_REVIEW_RENDER_SCALE,
      signal: renderOptions?.signal,
      timeoutMs: renderOptions?.timeoutMs ?? VISION_FINAL_REVIEW_RENDER_TIMEOUT_MS,
    }));
  const pageIssues: VisionFinalIssue[][] = Array.from({ length: options.targetPdf.numPages }, () => []);
  const sourcePageMap = buildTargetSourcePageMap(
    options.manifest,
    options.targetPdf.numPages,
    options.sourcePdf.numPages,
  );
  const runController = new AbortController();
  const onOuterAbort = () => runController.abort();
  if (options.signal?.aborted) runController.abort();
  else options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const runSignal = runController.signal;
  const performPageReview = async (targetPageIndex: number, pageSignal: AbortSignal): Promise<void> => {
    if (pageSignal.aborted) throw new DOMException('已停止', 'AbortError');
    options.onPageStart?.({ targetPageIndex, totalPages: options.targetPdf.numPages });
    const sourcePageIndices = sourcePageMap[targetPageIndex] ?? [];
    const renderReviewPage = async (
      document: PdfDocumentForVision,
      pageNumber: number,
      role: 'source' | 'target',
      pageIndex: number,
    ): Promise<string> => {
      const renderAttempt = async (scale: number): Promise<string> => {
        const page = await document.getPage(pageNumber);
        try {
          return await renderPage(page, role, pageIndex, {
            signal: pageSignal,
            scale,
            timeoutMs: VISION_FINAL_REVIEW_RENDER_TIMEOUT_MS,
          });
        } finally {
          try { page.cleanup?.(); } catch { /* release is best-effort */ }
        }
      };
      const scales = [
        VISION_FINAL_REVIEW_RENDER_SCALE,
        VISION_FINAL_REVIEW_FALLBACK_RENDER_SCALE,
        VISION_FINAL_REVIEW_LAST_RESORT_RENDER_SCALE,
      ];
      for (const [index, scale] of scales.entries()) {
        try {
          return await renderAttempt(scale);
        } catch (error) {
          if (!(error instanceof PdfPageRenderTimeoutError) || pageSignal.aborted) throw error;
          if (index < scales.length - 1) {
            options.onPagePhase?.({
              targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'render-retrying',
            });
            continue;
          }
          const elapsedTimeout = VISION_FINAL_REVIEW_RENDER_TIMEOUT_MS * scales.length;
          options.onPageTimeout?.({
            targetPageIndex,
            totalPages: options.targetPdf.numPages,
            timeoutMs: elapsedTimeout,
          });
          throw new VisionPageTimeoutError(
            targetPageIndex,
            options.targetPdf.numPages,
            elapsedTimeout,
          );
        }
      }
      throw new VisionPageTimeoutError(
        targetPageIndex,
        options.targetPdf.numPages,
        VISION_FINAL_REVIEW_RENDER_TIMEOUT_MS * scales.length,
      );
    };
    const content: NonNullable<ChatCompletionOptions['messages'][number]['content']> extends infer _T ? any[] : never = [
      { type: 'text', text: buildVisionFinalReviewPrompt(
        targetPageIndex + 1,
        sourcePageIndices.map((page) => page + 1),
        false,
        options.targetLayoutPolicy,
      ) },
    ];
    for (const sourcePageIndex of sourcePageIndices) {
      const sourceImage = await renderReviewPage(options.sourcePdf, sourcePageIndex + 1, 'source', sourcePageIndex);
      if (pageSignal.aborted) throw new DOMException('已停止', 'AbortError');
      content.push({ type: 'text', text: `SOURCE PAGE ${sourcePageIndex + 1}` });
      content.push({ type: 'image_url', image_url: { url: sourceImage, detail: 'original' } });
    }
    const targetImage = await renderReviewPage(options.targetPdf, targetPageIndex + 1, 'target', targetPageIndex);
    if (pageSignal.aborted) throw new DOMException('已停止', 'AbortError');
    options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'rendered' });
    content.push({ type: 'text', text: `TARGET PAGE ${targetPageIndex + 1}` });
    content.push({ type: 'image_url', image_url: { url: targetImage, detail: 'original' } });
    const requestReview = (compact: boolean) => {
      let contentReported = false;
      return complete({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: VISION_LAYOUT_MODEL,
      thinkingMode: 'disabled',
      responseFormat: 'json_object',
      stream: false,
      maxTokens: compact ? 384 : 768,
      // Non-streaming multimodal inference emits no response bytes while the
      // model is inspecting up to three high-resolution pages. A 30-second
      // inactivity window aborts healthy requests before their first byte.
      // The surrounding per-page 210-second deadline remains the hard guard.
      timeoutMs: compact ? 75_000 : 90_000,
      hardTimeoutMs: compact ? 90_000 : 120_000,
      signal: pageSignal,
      onStreamProgress: (progress) => {
        if (progress.phase === 'connected') {
          options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'connected' });
        } else if (progress.phase === 'content' && !contentReported) {
          contentReported = true;
          options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'content' });
        }
      },
      messages: [{ role: 'user', content: [
        { type: 'text', text: buildVisionFinalReviewPrompt(
          targetPageIndex + 1,
          sourcePageIndices.map((page) => page + 1),
          compact,
          options.targetLayoutPolicy,
        ) },
        ...content.slice(1),
      ] }],
      });
    };
    const requestReviewResilient = async (compact: boolean): Promise<ChatCompletionResult> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await requestReview(compact || attempt > 0);
        } catch (error) {
          const recoverable = isRetryableDeepSeekTransportError(error);
          if (!recoverable || attempt >= 2 || pageSignal.aborted) throw error;
          options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'retrying' });
        }
      }
      throw new Error('Vision 成品质检请求失败');
    };
    let completion = await requestReviewResilient(false);
    options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'returned' });
    if (pageSignal.aborted) throw new DOMException('已停止', 'AbortError');
    let pageReport: VisionFinalPageReport | undefined;
    for (let parseAttempt = 0; parseAttempt < 3 && !pageReport; parseAttempt += 1) {
      try {
        pageReport = parseVisionFinalPageReport(completion.content, targetPageIndex);
      } catch (error) {
        options.onPageInvalid?.({
          targetPageIndex,
          totalPages: options.targetPdf.numPages,
          reason: error instanceof Error ? error.message : '未知响应格式错误',
        });
        // JSON mode can still return a prose wrapper or truncated object.
        // This is a recoverable model-format failure; allow two compact
        // severe-only retries before failing the completed document.
        if (parseAttempt >= 2) throw error;
        options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'retrying' });
        completion = await requestReviewResilient(true);
        options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'returned' });
      }
    }
    if (!pageReport) throw new Error('Vision 成品质检 JSON 无法解析');
    const severeCandidates = pageReport.issues.filter(isBlockingVisionFinalIssue);
    if (severeCandidates.length) {
      const adjacentTargetContent: any[] = [];
      const adjacentTargetPageIndices = severeCandidates.some(isAuthorPortraitMissing)
        ? [targetPageIndex - 1, targetPageIndex + 1].filter((pageIndex) => (
          pageIndex >= 0 && pageIndex < options.targetPdf.numPages
        ))
        : [];
      for (const adjacentTargetPageIndex of adjacentTargetPageIndices) {
        const adjacentTargetImage = await renderReviewPage(
          options.targetPdf,
          adjacentTargetPageIndex + 1,
          'target',
          adjacentTargetPageIndex,
        );
        if (pageSignal.aborted) throw new DOMException('已停止', 'AbortError');
        adjacentTargetContent.push(
          { type: 'text', text: `ADJACENT TARGET PAGE ${adjacentTargetPageIndex + 1}` },
          { type: 'image_url', image_url: { url: adjacentTargetImage, detail: 'original' } },
        );
      }
      const requestConfirmation = () => {
        let contentReported = false;
        return complete({
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          model: VISION_LAYOUT_MODEL,
          thinkingMode: 'disabled',
          responseFormat: 'json_object',
          stream: false,
          maxTokens: 384,
          // A focused confirmation still carries the same high-resolution
          // source and target images. Give it the same inactivity allowance
          // as a compact first-pass review and let the page deadline remain
          // the absolute guard.
          timeoutMs: 90_000,
          hardTimeoutMs: 120_000,
          signal: pageSignal,
          onStreamProgress: (progress) => {
            if (progress.phase === 'connected') {
              options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'connected' });
            } else if (progress.phase === 'content' && !contentReported) {
              contentReported = true;
              options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'content' });
            }
          },
          messages: [{ role: 'user', content: [
            {
              type: 'text',
              text: buildVisionFinalConfirmationPrompt(
                targetPageIndex + 1,
                severeCandidates.map((issue) => ({
                  type: issue.type,
                  bbox: issue.bbox,
                  evidence: issue.evidence,
                })),
                adjacentTargetPageIndices.map((pageIndex) => pageIndex + 1),
              ),
            },
            // Changed-asset candidates require the same source references used
            // by the first pass. A target-only confirmation can mistake a
            // compact but intact ruled table for prose merely because its
            // typography differs from the surrounding translated text.
            ...content.slice(1),
            ...adjacentTargetContent,
          ] }],
        });
      };
      let confirmationReport: VisionFinalPageReport | undefined;
      for (let attempt = 0; attempt < 3 && !confirmationReport; attempt += 1) {
        try {
          const confirmation = await requestConfirmation();
          confirmationReport = parseVisionFinalPageReport(confirmation.content, targetPageIndex);
        } catch (error) {
          const recoverable = isRetryableDeepSeekTransportError(error)
            || (error instanceof Error && error.message.startsWith('Vision 成品质检'));
          if (!recoverable || attempt >= 2 || pageSignal.aborted) throw error;
          options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'retrying' });
        }
      }
      if (!confirmationReport) throw new Error('Vision 成品质检确认响应无效');
      const candidateTypes = new Set(severeCandidates.map((issue) => issue.type));
      pageReport = {
        targetPageIndex,
        issues: [
          ...pageReport.issues.filter((issue) => !severeCandidates.includes(issue)),
          ...confirmationReport.issues.filter((issue) => candidateTypes.has(issue.type)),
        ],
        pass: confirmationReport.pass,
      };
    }
    pageIssues[targetPageIndex] = pageReport.issues;
    options.onPage?.({ targetPageIndex, totalPages: options.targetPdf.numPages, issueCount: pageReport.issues.length });
    content.length = 0;
  };

  const reviewPage = (targetPageIndex: number): Promise<void> => withPageDeadline(
    (pageSignal) => performPageReview(targetPageIndex, pageSignal),
    runSignal,
    targetPageIndex,
    options.targetPdf.numPages,
    options.pageTimeoutMs ?? VISION_FINAL_REVIEW_PAGE_TIMEOUT_MS,
    () => options.onPageTimeout?.({
      targetPageIndex,
      totalPages: options.targetPdf.numPages,
      timeoutMs: options.pageTimeoutMs ?? VISION_FINAL_REVIEW_PAGE_TIMEOUT_MS,
    }),
    (elapsedMs) => options.onPageWait?.({
      targetPageIndex,
      totalPages: options.targetPdf.numPages,
      elapsedMs,
    }),
  );

  let nextTargetPageIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextTargetPageIndex < options.targetPdf.numPages) {
      const targetPageIndex = nextTargetPageIndex;
      nextTargetPageIndex += 1;
      try {
        await reviewPage(targetPageIndex);
      } catch (error) {
        if (!(error instanceof VisionPageTimeoutError)) throw error;
        pageIssues[targetPageIndex] = [{
          targetPageIndex,
          type: 'review_incomplete',
          severity: 'warning',
          bbox: [0, 0, 1000, 1000],
          confidence: 1,
          evidence: `V4.1 Flash 单页质检超过 ${Math.ceil((options.pageTimeoutMs ?? VISION_FINAL_REVIEW_PAGE_TIMEOUT_MS) / 1_000)} 秒，已跳过该页`,
        }];
        options.onPage?.({ targetPageIndex, totalPages: options.targetPdf.numPages, issueCount: 1 });
      }
    }
  };
  try {
    await Promise.all(Array.from(
      { length: Math.min(VISION_FINAL_REVIEW_CONCURRENCY, options.targetPdf.numPages) },
      () => worker(),
    ));
  } catch (error) {
    runController.abort();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
  let issues = pageIssues.flat();
  const incompletePages = issues.filter((issue) => issue.type === 'review_incomplete');
  // “逐页终审”必须覆盖每一页。即使其余页面全部通过，也不能把一次
  // 超时当作可接受的抽样缺口，否则正式成品可能包含一页从未被检查的
  // 裁切、重叠或资产损坏。
  const incompleteSet = new Set(incompletePages);
  issues = issues.map((issue) => incompleteSet.has(issue) ? { ...issue, severity: 'severe' } : issue);

  if (runSignal.aborted) {
    throw new DOMException('已停止', 'AbortError');
  }
  return {
    pass: !issues.some(isBlockingVisionFinalIssue),
    issues,
    reviewedPages: options.targetPdf.numPages - incompletePages.length,
  };
}
