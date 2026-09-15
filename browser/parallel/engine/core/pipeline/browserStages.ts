import type { AiLogEvent } from '../translate/events';
import type { ProjectRepository } from '../project/repository';
import type {
  AlignmentUnit,
  TaskSnapshot,
  Doc,
  Rect,
  SemanticUnit,
  VisionAttemptState,
} from '../../types/models';
import type { ProductionPipelineStages, PipelineValue } from './productionPipeline';
import { getDocument } from '../pdf/runtime';
import { extractBitmapRegions } from '../pdf/bitmapRegions';
import { detectFontFormulaRegions } from '../pdf/formulaRegions';
import { measureFormulaTextRuns } from '../pdf/formulaTextRuns';
import { normalizeTextItem } from '../parser/pdfjsAdapter';
import { parsePageItems } from '../parser';
import { buildDoc, type ParsedPage } from '../parser/docBuilder';
import {
  prepareImmutableStructure,
  buildTranslationRequestsFromDoc,
  normalizeDeepSeekTranslationResponse,
  parseDeepSeekTranslationJson,
} from './preparation';
import { extractImmutableAssets } from '../assets/extract';
import { ASSET_CROP_RENDER_VERSION, cropPageRegionLossless } from '../assets/crop';
import { renderLatexFormulaPng } from '../assets/formulaRender';
import { buildTranslationBatches, translationLimitsFor } from '../translate/batcher';
import { runTranslationTask } from '../translate/coordinator';
import {
  maskProtectedTokensForTranslation,
  restoreMissingProtectedTokensFromTranslation,
  restoreProtectedTokensFromTranslation,
} from '../translate/protected';
import { buildSingleBlockRepairPlan } from '../translate/repair';
import {
  chatCompletion,
  isNonRetryableDeepSeekAccountError,
  isRetryableDeepSeekTransportError,
} from '../translate/client';
import {
  buildBatchPrompt,
  buildSystemPrompt,
  buildTranslationRecoveryInstruction,
  SYSTEM_PROMPT_VERSION,
} from '../translate/prompts';
import type { TranslationBlockRequest, TranslationBlockResponse, TranslationRequest } from '../translate/protocol';
import {
  buildAcceptedPagePlanCacheKey,
  buildFormulaOcrCacheKey,
  buildRawVisionResponseCacheKey,
  buildRecoveredPagePlanCacheKey,
  buildTranslationCacheKey,
  buildVisionCorrectionPatchCacheKey,
  type VisionPlanCacheIdentity,
} from '../project/cacheKey';
import { buildSemanticGroups, buildBlockAndAssetAlignmentUnits } from '../align/semanticUnits';
import {
  buildTypstProject,
  type LayoutRepairPlan,
  type TypstProject,
  type TypstSemanticUnit,
} from '../typst/project';
import { compileTypstProject, type TypstCompileResult } from '../typst/compiler';
import { paragraphFlowGroups } from '../typst/paragraphFlow';
import { getTypstRuntimePaths } from '../typst/runtimePaths';
import { readTargetMarkers } from '../align/targetMarkers';
import { matchTranslatedText, type TargetTextSegment } from '../align/textFallback';
import { resolveSourceGeometry } from '../align/sourceGeometry';
import { buildAlignmentManifest, type AlignmentManifest } from '../align/manifest';
import { runAlignmentGate } from '../quality/alignmentGate';
import type { ImmutableAsset } from '../assets/types';
import {
  analyzePdfLayoutWithVision,
  VISION_LAYOUT_MODEL,
  VISION_LAYOUT_FALLBACK_RENDER_SCALE,
  VISION_LAYOUT_LAST_RESORT_RENDER_SCALE,
  VISION_LAYOUT_PARSER_VERSION,
  VISION_LAYOUT_RECOVERY_VERSION,
  VISION_LAYOUT_RENDER_SCALE,
  VISION_LAYOUT_VERIFIER_VERSION,
  VISION_PAGE_PLAN_PROTOCOL_VERSION,
  VISION_RENDER_VERSION,
} from '../vision/analyze';
import { REQUIRED_VISION_MODEL_ID } from '../vision/model';
import { normalizeDeepSeekTaskSettings } from '../translate/models';
import { authorPortraitAssetsFromBitmapRegions, reconcileVisionLayout } from '../vision/reconcile';
import {
  findAssetFooterOverflows,
  inspectCompiledPdf,
  runPdfContentGate,
} from '../quality/pdfContentGate';
import { persistValidatedOutputs } from '../quality/finalPersistence';
import {
  isBlockingVisionFinalIssue,
  runVisionFinalReview,
  type VisionFinalIssue,
  type VisionFinalReport,
} from '../vision/finalReview';
import {
  FORMULA_OCR_MODEL,
  FORMULA_OCR_PROMPT_VERSION,
  parseCachedFormulaOcrResult,
  recognizeFormulaCrop,
} from '../vision/formulaOcr';
import type { TargetLayoutPolicy } from '../typst/template';
import { buildLayoutRepairPlan, type PdfPageSize } from '../quality/layoutRepair';
import type {
  QualityAttemptReport,
  QualityReport,
  SourceLayoutCorrectionAttempt,
  SourceLayoutQualityReport,
} from '../quality/report';
import { preserveSourceLayoutRunHistory } from '../quality/report';
import { assertPreparedStructure } from './structureInvariants';
import {
  MarkerInvariantError,
  validateGlobalMarkers,
  validateTranslationBlockMarkers,
} from './markerInvariants';
import {
  planToVisionAnalysis,
  VISION_PLAN_CANONICALIZATION_VERSION,
  withRecomputedPlanVersion,
  type VisionPagePlan,
} from '../vision/pagePlan';
import { VISION_LAYOUT_PROMPT_VERSION } from '../vision/prompts';
import {
  applyVisionCorrectionPatch,
  replayCachedVisionCorrection,
  requestVisionCorrection,
  type VisionCorrectionLocalContext,
  VISION_CORRECTION_PROMPT_VERSION,
  VisionPatchError,
} from '../vision/correction';
import {
  isVisionCorrectableReason,
  hasSubstantiveVisionCorrectionProgress,
  reconciliationValidationIssues,
  recoverLocallyRejectedRegions,
} from '../vision/recoveryPolicy';
import { PdfPageRenderTimeoutError, renderPdfPageAsPng } from '../vision/render';
import { RecoverablePipelineError } from '../task/recoverable';
import { awaitWithDeadline } from '../task/asyncDeadline';
import { CachePersistenceError } from '../project/cacheErrors';
import { safeErrorMessage } from '../security/errors';
import {
  inferCrossPageAssetCandidates,
  digestAcceptedDocumentPlan,
  validateCrossPageAssetCandidates,
  type CrossPageAssetGroup,
} from '../vision/crossPageRelations';

const SESSION_KEY_STORAGE = 'paper-parallel.deepseek-key-session';
const LOCAL_KEY_STORAGE = 'paper-parallel.deepseek-key';

interface BrowserValue extends PipelineValue {
  projectId: string;
  settings: NonNullable<TaskSnapshot['settings']>;
  sourcePdf?: any;
  sourceBitmapRegions?: Map<number, Rect[]>;
  sourceFontFormulas?: ReturnType<typeof detectFontFormulaRegions>;
  doc?: Doc;
  prepared?: ReturnType<typeof prepareImmutableStructure>;
  assets?: ImmutableAsset[];
  glossary?: Array<{ source: string; target: string; abbreviation?: string }>;
  requests?: TranslationBlockRequest[];
  translations?: TranslationBlockResponse[];
  typstProject?: TypstProject;
  typstUnits?: TypstSemanticUnit[];
  compiled?: TypstCompileResult;
  manifest?: AlignmentManifest;
  requiredBlocks?: number;
  validatedBlocks?: number;
  visionAttempt?: VisionAttemptState;
  crossPageAssetGroups?: CrossPageAssetGroup[];
  sourceLayoutReport?: SourceLayoutQualityReport;
  acceptedDocumentPlanDigest?: string;
}

export interface BrowserPipelineStageOptions {
  projectId: string;
  snapshot: TaskSnapshot;
  repository: ProjectRepository;
  apiKey?: string;
  baseUrl?: string;
  concurrency?: number;
  maxRetries?: number;
  onAiEvent?(event: AiLogEvent): void;
  onCompileProgress?(phase: string): void;
  onPreview?(event: { svg: string; attempt: 0 | 1 | 2 }): void;
}

function value(input: PipelineValue): BrowserValue {
  return input as BrowserValue;
}

function requireValue<T>(item: T | undefined, message: string): T {
  if (item === undefined) throw new Error(message);
  return item;
}

function normalizeDocPages(doc: Doc): Doc {
  return {
    ...doc,
    blocks: doc.blocks.map((block) => ({
      ...block,
      pageIndex: Math.max(0, block.pageIndex - 1),
      fragments: block.fragments?.map((fragment) => ({ ...fragment, pageIndex: Math.max(0, fragment.pageIndex - 1) })),
    })),
    layoutRegions: doc.layoutRegions.map((region) => ({
      ...region, sourcePage: Math.max(0, region.sourcePage - 1), orderedUnitIds: [...region.orderedUnitIds],
    })),
  };
}

function responseGroups(
  request: TranslationBlockRequest,
  response: TranslationBlockResponse,
) {
  return buildSemanticGroups({
    blockId: request.blockId,
    mode: request.alignmentMode,
    sentences: request.sourceSentences,
  }, response.alignmentGroups);
}

function typstTextUnit(
  unit: SemanticUnit,
  request: TranslationBlockRequest,
  response: TranslationBlockResponse,
): TypstSemanticUnit {
  const groups = responseGroups(request, response);
  const targetSegments: TargetTextSegment[] = [];
  groups.forEach((group, groupIndex) => {
    const texts = response.alignmentGroups[groupIndex]?.targetSegments ?? [];
    group.targetUnitIds.forEach((id, segmentIndex) => targetSegments.push({ id, targetText: texts[segmentIndex] ?? '' }));
  });
  return {
    id: unit.id, kind: unit.kind, layoutRegionId: unit.layoutRegionId, order: unit.order,
    headingLevel: unit.headingLevel, headingNumber: unit.headingNumber,
    targetSegments: targetSegments.map((segment) => ({ id: segment.id, text: segment.targetText })),
  };
}

function typstSourceColumn(
  unit: SemanticUnit,
  doc: Doc,
  assets: readonly ImmutableAsset[],
): TypstSemanticUnit['sourceColumn'] {
  const block = doc.blocks.find((candidate) => candidate.id === unit.id)
    ?? (unit.parentId ? doc.blocks.find((candidate) => candidate.id === unit.parentId) : undefined);
  const asset = unit.assetId
    ? assets.find((candidate) => candidate.id === unit.assetId)
    : assets.find((candidate) => candidate.captionUnitId === unit.id);
  const rect = asset?.sourceRect ?? block?.rect;
  const pageIndex = asset?.sourcePage ?? block?.pageIndex ?? 0;
  const pageWidth = doc.pages[pageIndex]?.width ?? doc.meta.paperWidth;
  if (!rect || !Number.isFinite(pageWidth) || pageWidth <= 0) return 'span';
  if (rect.w >= pageWidth * 0.55) return 'span';
  return rect.x + rect.w / 2 < pageWidth / 2 ? 'left' : 'right';
}

function reusableSourceLayoutReport(value: unknown): SourceLayoutQualityReport | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const report = value as Partial<SourceLayoutQualityReport>;
  return (report.schemaVersion === 1 || report.schemaVersion === 2)
    && typeof report.pass === 'boolean'
    && Array.isArray(report.correctionAttempts)
    && Array.isArray(report.unresolvedIssues)
    && Number.isFinite(report.initialAnalysisCalls)
    && Number.isFinite(report.correctionCallsUsed)
    && Number.isFinite(report.maxCorrectionCalls)
    && Number.isFinite(report.promptTokens)
    && Number.isFinite(report.completionTokens)
    ? report as SourceLayoutQualityReport
    : undefined;
}

async function blobDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

async function buildAlignmentForCompiled(
  current: BrowserValue,
  compiled: TypstCompileResult,
  projectId: string,
): Promise<AlignmentManifest> {
  const doc = requireValue(current.doc, '解析文档缺失');
  const requests = requireValue(current.requests, '翻译请求缺失');
  const translations = requireValue(current.translations, '翻译结果缺失');
  const prepared = requireValue(current.prepared, '版式结构缺失');
  const targetLoading = getDocument({ data: compiled.pdf.slice() });
  const targetPdf = await targetLoading.promise;
  try {
    const markers = await readTargetMarkers(targetPdf as any);
    const segments: TargetTextSegment[] = [];
    const preparedById = new Map(prepared.units.map((unit) => [unit.id, unit]));
    let units: AlignmentUnit[] = requests.flatMap((request) => {
      const response = translations.find((candidate) => candidate.blockId === request.blockId)!;
      const groups = responseGroups(request, response);
      groups.forEach((group, groupIndex) => group.targetUnitIds.forEach((id, index) => {
        segments.push({ id, targetText: response.alignmentGroups[groupIndex].targetSegments[index] });
      }));
      const preparedUnit = preparedById.get(request.blockId);
      const sourceBlockId = preparedUnit?.sourceBlockId;
      const sourceBlockIds = preparedUnit?.sourceBlockIds;
      return groups.map((group) => ({ ...group, sourceBlockId, sourceBlockIds }));
    });
    const immutable = prepared.units.filter((unit) => Boolean(unit.assetId));
    units.push(...buildBlockAndAssetAlignmentUnits(immutable));
    units = resolveSourceGeometry(units, doc, current.assets ?? []);
    const fallback = await matchTranslatedText(targetPdf as any, segments);
    return buildAlignmentManifest({ projectId, units, markers, fallback });
  } finally {
    await targetPdf.destroy();
  }
}

async function persistQualityReport(
  repository: ProjectRepository,
  report: QualityReport,
): Promise<void> {
  await repository.putArtifact({
    key: `${report.projectId}:quality-report`,
    projectId: report.projectId,
    kind: 'quality-report',
    blob: new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
    updatedAt: report.createdAt,
  });
}

export function createBrowserPipelineStages(options: BrowserPipelineStageOptions): ProductionPipelineStages {
  const settings = normalizeDeepSeekTaskSettings(requireValue(options.snapshot.settings, '任务缺少模型与源文件设置'));
  const apiKey = options.apiKey
    ?? sessionStorage.getItem(SESSION_KEY_STORAGE)
    ?? localStorage.getItem(LOCAL_KEY_STORAGE)
    ?? '';
  const targetLayoutPolicy: TargetLayoutPolicy = settings.targetLayoutPolicy === 'single-column'
    ? 'single-column'
    : 'source-layout';
  const visionModelId = settings.visionModelId ?? REQUIRED_VISION_MODEL_ID;
  if (visionModelId !== REQUIRED_VISION_MODEL_ID) {
    throw new Error(`任务视觉模型 ${visionModelId} 不受当前正式质量门支持`);
  }
  const skipRemoteFinalReview = import.meta.env.MODE === 'test'
    && import.meta.env.VITE_PP_SKIP_REMOTE_FINAL_REVIEW === '1';

  return {
    async parse(input, signal) {
      const current = value(input);
      const wait = <T>(operation: PromiseLike<T>, message: string): Promise<T> => awaitWithDeadline(operation, {
        signal, timeoutMs: 60_000, timeoutMessage: message,
      });
      const artifact = await wait(options.repository.findArtifact(`${options.projectId}:english-pdf`), '读取原文 PDF 超时');
      if (!artifact) throw new Error('英文原文 PDF 不存在');
      const bytes = await wait(artifact.blob.arrayBuffer(), '读取原文 PDF 数据超时');
      signal.throwIfAborted();
      const loading = getDocument({ data: new Uint8Array(bytes) });
      try {
        const pdf = await wait(loading.promise, '打开 PDF 超时');
        const pages: ParsedPage[] = [];
        const sourceBitmapRegions = new Map<number, Rect[]>();
        const sourceFontFormulas: ReturnType<typeof detectFontFormulaRegions> = [];
        for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
          if (signal.aborted) throw new DOMException('已停止', 'AbortError');
          const page = await wait(pdf.getPage(pageIndex + 1), `读取 PDF 第 ${pageIndex + 1} 页超时`);
          const viewport = page.getViewport({ scale: 1 });
          const content = await wait(page.getTextContent(), `提取 PDF 第 ${pageIndex + 1} 页文字超时`);
          const operatorList = await wait(page.getOperatorList(), `解析 PDF 第 ${pageIndex + 1} 页图形超时`);
          sourceBitmapRegions.set(pageIndex, extractBitmapRegions(operatorList, viewport.transform));
          await document.fonts?.ready;
          sourceFontFormulas.push(...detectFontFormulaRegions(measureFormulaTextRuns(
            content.items.filter((item: any) => typeof item?.str === 'string') as any,
            viewport, operatorList, (fontId) => page.commonObjs.get(fontId),
          ), pageIndex));
          const items = content.items
            .filter((item: any) => typeof item?.str === 'string')
            .map((item: any) => normalizeTextItem(item, viewport));
          const parsed = parsePageItems(items, viewport.width, viewport.height);
          pages.push({
            no: pageIndex + 1, w: viewport.width, h: viewport.height,
            layoutMode: parsed.layoutMode,
            blocks: parsed.blocks.map((block) => ({ ...block })),
          });
        }
        const doc = normalizeDocPages(buildDoc(pages, 'en'));
        if (!doc.blocks.length) throw new Error('PDF 没有可用的文字层，暂不支持扫描件');
        return { ...current, settings, sourcePdf: pdf, sourceBitmapRegions, sourceFontFormulas, doc };
      } catch (error) {
        // PDF.js may never settle a pending operator-list request after destroy.
        // The deadline settles our wait; cleanup must not delay stop or timeout.
        void loading.destroy().catch(() => undefined);
        throw error;
      }
    },

    async analyzeLayout(input, signal, reportProgress) {
      const current = value(input);
      const doc = requireValue(current.doc, '解析文档缺失');
      const pdf = requireValue(current.sourcePdf, '源 PDF 缺失');
      if (!apiKey.trim()) throw new Error('V4.1 Flash 版式识别需要 DeepSeek API Key，请返回上传页重新验证');
      const sourceLayoutRunStartedAt = Date.now();
      let priorSourceLayoutReport: SourceLayoutQualityReport | undefined;
      let priorSourceLayoutUpdatedAt = sourceLayoutRunStartedAt;
      try {
        const priorArtifact = await options.repository.findArtifact(`${options.projectId}:vision-diagnostic`);
        if (priorArtifact) {
          priorSourceLayoutUpdatedAt = priorArtifact.updatedAt;
          priorSourceLayoutReport = reusableSourceLayoutReport(JSON.parse(await priorArtifact.blob.text()));
        }
      } catch {
        // Diagnostics are never authoritative inputs. Corrupt history is
        // ignored while the current run continues from validated page caches.
      }
      let priorRunHistory: ReturnType<typeof preserveSourceLayoutRunHistory> = [];
      try {
        priorRunHistory = preserveSourceLayoutRunHistory(
          priorSourceLayoutReport,
          priorSourceLayoutUpdatedAt,
        );
      } catch {
        // Historical diagnostics never participate in formal correctness. A
        // malformed nested attempt/history record is ignored just like a
        // malformed top-level diagnostic, rather than blocking fresh analysis.
        priorSourceLayoutReport = undefined;
        priorRunHistory = [];
      }
      const plansByPage = new Map<number, VisionPagePlan>();
      const cachedPlanPages = new Set<number>();
      let initialAnalysisCalls = 0;
      let initialPromptTokens = 0;
      let initialCompletionTokens = 0;
      let analyses = await analyzePdfLayoutWithVision({
        pdf,
        baseUrl: options.baseUrl ?? 'https://api.deepseek.com',
        apiKey,
        fileHash: settings.sourceFileHash,
        signal,
        loadCached: async (key) => {
          const artifact = await options.repository.findArtifact(key);
          return artifact ? JSON.parse(await artifact.blob.text()) : undefined;
        },
        loadAccepted: async (key) => {
          const artifact = await options.repository.findArtifact(key);
          return artifact ? JSON.parse(await artifact.blob.text()) : undefined;
        },
        loadRecovered: async (key) => {
          const artifact = await options.repository.findArtifact(key);
          return artifact ? JSON.parse(await artifact.blob.text()) : undefined;
        },
        saveRaw: async (key, pageIndex, response) => options.repository.putArtifact({
          key,
          projectId: options.projectId,
          kind: 'raw-vision-response',
          blob: new Blob([JSON.stringify(response)], { type: 'application/json' }),
          updatedAt: Date.now(),
          dependencies: { pageIndices: [pageIndex], cacheIdentityVersion: 'vision-cache-v1' },
        }),
        saveRecovered: async (key, pageIndex, plan) => options.repository.putArtifact({
          key,
          projectId: options.projectId,
          kind: 'recovered-page-plan',
          blob: new Blob([JSON.stringify(plan)], { type: 'application/json' }),
          updatedAt: Date.now(),
          dependencies: {
            pageIndices: [pageIndex], planVersion: plan.planVersion,
            cacheIdentityVersion: 'vision-cache-v1',
          },
        }),
        onPlan: ({ pageIndex, plan, cached }) => {
          plansByPage.set(pageIndex, plan);
          if (cached) cachedPlanPages.add(pageIndex);
        },
        onPageStart: (event) => options.onAiEvent?.({
          type: 'vision-layout-page-started', at: Date.now(), page: event.pageIndex + 1,
          totalPages: event.totalPages,
        }),
        onPagePhase: (event) => options.onAiEvent?.({
          type: 'vision-layout-page-phase', at: Date.now(), page: event.pageIndex + 1,
          totalPages: event.totalPages, phase: event.phase,
        }),
        onPage: (event) => {
          initialAnalysisCalls += event.networkAttempts;
          initialPromptTokens += event.promptTokens;
          initialCompletionTokens += event.completionTokens;
          options.onAiEvent?.({
            type: 'vision-layout-page', at: Date.now(), page: event.pageIndex + 1,
            totalPages: event.totalPages, cached: event.cached,
            networkAttempts: event.networkAttempts,
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
          });
          reportProgress?.({
            phase: 'local-validation', pageIndex: event.pageIndex, totalPages: pdf.numPages,
            correctionRound: 0, remainingPageRounds: 2,
            validatedPages: plansByPage.size, failedPages: [], cachedPages: cachedPlanPages.size,
            correctionCallsUsed: 0, maxCorrectionCalls: settings.maxVisionCorrectionCalls ?? 0,
            promptTokens: initialPromptTokens, completionTokens: initialCompletionTokens,
          });
        },
      });
      const sourceBitmapRegions = current.sourceBitmapRegions ?? new Map<number, Rect[]>();
      let reconciled = reconcileVisionLayout(doc, analyses, 0.8, sourceBitmapRegions);
      for (const [pageIndex, plan] of plansByPage) {
        plansByPage.set(pageIndex, recoverLocallyRejectedRegions(plan, reconciled));
      }
      analyses = [...plansByPage.values()]
        .sort((left, right) => left.pageIndex - right.pageIndex)
        .map(planToVisionAnalysis);
      reconciled = reconcileVisionLayout(doc, analyses, 0.8, sourceBitmapRegions);

      let correctionIssues = reconciliationValidationIssues(plansByPage, reconciled)
        .filter((issue) => reconciled.unresolved.some((item) => (
          item.pageIndex === issue.pageIndex
          && item.regionId === issue.regionId
          && isVisionCorrectableReason(item.reason)
        )));
      const failedPageCount = new Set(correctionIssues.map((issue) => issue.pageIndex)).size;
      const maxCorrectionCalls = settings.maxVisionCorrectionCalls
        ?? Math.min(failedPageCount * 2, 12);
      const persistedCorrectionCalls = options.snapshot.visionAttempt
        && options.snapshot.visionAttempt.correctionRound > 0
        && options.snapshot.pauseReason !== 'vision-correction-budget-exhausted'
        ? options.snapshot.visionAttempt.correctionCallsUsed
        : 0;
      let correctionCallsUsed = Math.min(maxCorrectionCalls, persistedCorrectionCalls);
      let correctionPromptTokens = 0;
      let correctionCompletionTokens = 0;
      let lastCorrectionRound = 0 as 0 | 1 | 2;
      const sourceCorrectionAttempts: SourceLayoutCorrectionAttempt[] = [];
      const buildSourceLayoutReport = (
        pass: boolean,
        issues: readonly ReturnType<typeof reconciliationValidationIssues>[number][],
        crossPageAssetGroups: readonly CrossPageAssetGroup[] = [],
      ): SourceLayoutQualityReport => ({
        schemaVersion: 2,
        runStartedAt: sourceLayoutRunStartedAt,
        completedAt: Date.now(),
        runHistory: priorRunHistory.map((run) => ({
          ...run,
          correctionAttempts: run.correctionAttempts.map((attempt) => ({
            ...attempt, errorFingerprints: [...attempt.errorFingerprints],
          })),
          unresolvedIssues: run.unresolvedIssues.map((issue) => ({ ...issue })),
        })),
        pass,
        pagePlans: [...plansByPage.values()]
          .sort((left, right) => left.pageIndex - right.pageIndex)
          .map((plan) => ({
            pageIndex: plan.pageIndex,
            planVersion: plan.planVersion,
            planDigest: plan.planDigest,
            origin: plan.origin,
            recoveryActions: plan.recoveryActions.map((action) => ({ ...action })),
          })),
        correctionAttempts: sourceCorrectionAttempts.map((attempt) => ({
          ...attempt, errorFingerprints: [...attempt.errorFingerprints],
        })),
        initialAnalysisCalls,
        initialPromptTokens,
        initialCompletionTokens,
        correctionCallsUsed,
        maxCorrectionCalls,
        promptTokens: initialPromptTokens + correctionPromptTokens,
        completionTokens: initialCompletionTokens + correctionCompletionTokens,
        unresolvedIssues: issues.map((issue) => ({
          pageIndex: issue.pageIndex,
          regionId: issue.regionId,
          code: issue.code,
          reason: issue.reason,
          fingerprint: issue.fingerprint,
        })),
        crossPageAssetGroups: crossPageAssetGroups.map((group) => ({
          ...group,
          members: group.members.map((member) => ({ ...member })),
          weakEvidence: [...group.weakEvidence],
          provenance: [...group.provenance],
        })),
      });
      const persistSourceLayoutReport = async (
        pass: boolean,
        issues: readonly ReturnType<typeof reconciliationValidationIssues>[number][],
        crossPageAssetGroups: readonly CrossPageAssetGroup[] = [],
      ): Promise<SourceLayoutQualityReport> => {
        const report = buildSourceLayoutReport(pass, issues, crossPageAssetGroups);
        await options.repository.putArtifact({
          key: `${options.projectId}:vision-diagnostic`,
          projectId: options.projectId,
          kind: 'vision-diagnostic',
          blob: new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
          updatedAt: Date.now(),
          dependencies: {
            pageIndices: [...plansByPage.keys()].sort((left, right) => left - right),
            cacheIdentityVersion: 'vision-cache-v1',
          },
        });
        return report;
      };
      const pausedVisionAttempt = (
        pageIndex: number,
        round: 0 | 1 | 2,
        errorCode: string,
        errorMessage: string,
      ): VisionAttemptState => {
        const failedPages = [...new Set([
          ...correctionIssues.map((issue) => issue.pageIndex),
          ...reconciled.unresolved.map((issue) => issue.pageIndex),
        ])].sort((a, b) => a - b);
        return {
          phase: round === 0 ? 'local-validation' : round === 1 ? 'correction-full-page' : 'correction-local-crop',
          pageIndex,
          totalPages: pdf.numPages,
          correctionRound: round,
          remainingPageRounds: Math.max(0, 2 - round),
          validatedPages: Math.max(0, pdf.numPages - failedPages.length),
          failedPages,
          cachedPages: cachedPlanPages.size,
          correctionCallsUsed,
          maxCorrectionCalls,
          promptTokens: initialPromptTokens + correctionPromptTokens,
          completionTokens: initialCompletionTokens + correctionCompletionTokens,
          errorCode,
          errorMessage,
        };
      };
      for (let round = 1 as 1 | 2; correctionIssues.length && round <= 2; round = (round + 1) as 1 | 2) {
        lastCorrectionRound = round;
        const issuesBeforeRound = correctionIssues;
        const pageIndices = [...new Set(issuesBeforeRound.map((issue) => issue.pageIndex))].sort((a, b) => a - b);
        for (const pageIndex of pageIndices) {
          const pageIssues = issuesBeforeRound.filter((issue) => issue.pageIndex === pageIndex);
          const primaryIssue = pageIssues[0];
          const primaryAllowedFields = new Set(primaryIssue?.allowedFields ?? []);
          const repairAction = primaryAllowedFields.has('regions')
            ? 'add-or-remove-region' as const
            : primaryAllowedFields.has('captionBBox') || primaryAllowedFields.has('captionLink')
              ? 'adjust-caption' as const
              : primaryAllowedFields.has('orderCandidates')
                ? 'adjust-reading-order' as const
                : 'adjust-geometry' as const;
          if (correctionCallsUsed >= maxCorrectionCalls) {
            options.onAiEvent?.({
              type: 'vision-correction-stopped', at: Date.now(), page: pageIndex + 1,
              totalPages: pdf.numPages, round, reason: 'budget-exhausted',
              correctionCallsUsed, maxCorrectionCalls,
            });
            await persistSourceLayoutReport(false, correctionIssues);
            throw new RecoverablePipelineError(
              'vision-correction-budget-exhausted',
              `V4.1 Flash 版式纠错达到任务调用上限 ${maxCorrectionCalls}，任务已暂停`,
              pausedVisionAttempt(
                pageIndex, round, 'source-plan.correction-budget-exhausted',
                '任务级视觉纠错调用预算已耗尽',
              ),
            );
          }
          const failedRegionIds = new Set(pageIssues.flatMap((issue) => issue.regionId ? [issue.regionId] : []));
          const currentPlan = requireValue(plansByPage.get(pageIndex), `缺少第 ${pageIndex + 1} 页视觉计划`);
          const patchBase = withRecomputedPlanVersion({
            ...currentPlan,
            regions: currentPlan.regions.map((region) => ({
              ...region,
              locked: !failedRegionIds.has(region.id),
            })),
          });
          const candidateRegionType = patchBase.regions.find((region) => region.id === primaryIssue?.regionId)?.type;
          const correctionRegionType = candidateRegionType
            && ['figure', 'table', 'display_formula', 'code'].includes(candidateRegionType)
            ? candidateRegionType as 'figure' | 'table' | 'display_formula' | 'code'
            : 'page' as const;
          plansByPage.set(pageIndex, patchBase);
          const page = await pdf.getPage(pageIndex + 1);
          let imageUrl: string | undefined;
          let correctionLocalContext: VisionCorrectionLocalContext | undefined;
          let correctionRenderScale = round === 1 ? VISION_LAYOUT_RENDER_SCALE : 6;
          try {
            if (round === 1) {
              let renderError: unknown;
              for (const scale of [
                VISION_LAYOUT_RENDER_SCALE,
                VISION_LAYOUT_FALLBACK_RENDER_SCALE,
                VISION_LAYOUT_LAST_RESORT_RENDER_SCALE,
              ]) {
                try {
                  imageUrl = await renderPdfPageAsPng(page, { scale, signal, timeoutMs: 30_000 });
                  correctionRenderScale = scale;
                  renderError = undefined;
                  break;
                } catch (error) {
                  if (!(error instanceof PdfPageRenderTimeoutError) || signal.aborted) throw error;
                  renderError = error;
                  options.onAiEvent?.({
                    type: 'vision-layout-page-phase', at: Date.now(), page: pageIndex + 1,
                    totalPages: pdf.numPages, phase: 'render-retrying',
                  });
                }
              }
              if (!imageUrl) throw renderError ?? new Error('纠错整页渲染失败');
            } else {
              const sourcePage = doc.pages[pageIndex]!;
              const left = Math.min(...pageIssues.map((issue) => (
                (plansByPage.get(pageIndex)?.regions.find((region) => region.id === issue.regionId)?.bbox[0] ?? 0)
                  / 1000 * sourcePage.width
              )));
              const top = Math.min(...pageIssues.map((issue) => (
                (plansByPage.get(pageIndex)?.regions.find((region) => region.id === issue.regionId)?.bbox[1] ?? 0)
                  / 1000 * sourcePage.height
              )));
              const right = Math.max(...pageIssues.map((issue) => {
                const box = plansByPage.get(pageIndex)?.regions.find((region) => region.id === issue.regionId)?.bbox;
                return ((box?.[0] ?? 0) + (box?.[2] ?? 1000)) / 1000 * sourcePage.width;
              }));
              const bottom = Math.max(...pageIssues.map((issue) => {
                const box = plansByPage.get(pageIndex)?.regions.find((region) => region.id === issue.regionId)?.bbox;
                return ((box?.[1] ?? 0) + (box?.[3] ?? 1000)) / 1000 * sourcePage.height;
              }));
              const context = 24;
              const cropRect = {
                x: Math.max(0, left - context),
                y: Math.max(0, top - context),
                w: Math.min(sourcePage.width, right + context) - Math.max(0, left - context),
                h: Math.min(sourcePage.height, bottom + context) - Math.max(0, top - context),
              };
              const normalizeRect = (rect: Rect): [number, number, number, number] => [
                rect.x / sourcePage.width * 1000,
                rect.y / sourcePage.height * 1000,
                rect.w / sourcePage.width * 1000,
                rect.h / sourcePage.height * 1000,
              ];
              const cropBottom = cropRect.y + cropRect.h;
              const distanceFromCrop = (rect: Rect): number => {
                const bottom = rect.y + rect.h;
                if (bottom < cropRect.y) return cropRect.y - bottom;
                if (rect.y > cropBottom) return rect.y - cropBottom;
                return 0;
              };
              const adjacentTextAnchors = doc.blocks
                .filter((block) => block.pageIndex === pageIndex && Boolean(block.text?.trim()))
                .map((block) => ({ block, distance: distanceFromCrop(block.rect) }))
                .filter((entry) => entry.distance <= Math.max(72, sourcePage.height * 0.12))
                .sort((left, right) => left.distance - right.distance || left.block.order - right.block.order)
                .slice(0, 8)
                .map(({ block }) => ({
                  blockId: block.id,
                  relation: block.rect.y + block.rect.h <= cropRect.y
                    ? 'before' as const
                    : block.rect.y >= cropBottom
                      ? 'after' as const
                      : 'overlap' as const,
                  bbox: normalizeRect(block.rect),
                  text: (block.text ?? '').replace(/\p{Cc}+/gu, ' ')
                    .replace(/\s+/g, ' ').trim().slice(0, 120),
                }));
              correctionLocalContext = {
                cropBBox: normalizeRect(cropRect),
                adjacentTextAnchors,
                candidateRegions: pageIssues.flatMap((issue) => {
                  const region = patchBase.regions.find((candidate) => candidate.id === issue.regionId);
                  return region ? [{
                    regionId: region.id,
                    type: region.type,
                    bbox: [...region.bbox] as [number, number, number, number],
                    issueCodes: pageIssues
                      .filter((candidate) => candidate.regionId === region.id)
                      .map((candidate) => candidate.code),
                  }] : [];
                }),
              };
              let renderError: unknown;
              for (const scale of [6, 4, 2]) {
                try {
                  imageUrl = await blobDataUrl(await cropPageRegionLossless(page, cropRect, scale));
                  correctionRenderScale = scale;
                  renderError = undefined;
                  break;
                } catch (error) {
                  if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
                  renderError = error;
                  options.onAiEvent?.({
                    type: 'vision-layout-page-phase', at: Date.now(), page: pageIndex + 1,
                    totalPages: pdf.numPages, phase: 'render-retrying',
                  });
                }
              }
              if (!imageUrl) throw renderError ?? new Error('纠错局部裁图失败');
            }
          } catch (error) {
            if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
            await persistSourceLayoutReport(false, correctionIssues);
            throw new RecoverablePipelineError(
              'render-retries-exhausted',
              `第 ${pageIndex + 1} 页视觉纠错图像连续渲染失败，任务已暂停`,
              pausedVisionAttempt(
                pageIndex, round, 'transient.render-retries-exhausted', '视觉纠错图像连续渲染失败',
              ),
            );
          } finally {
            try { page.cleanup?.(); } catch { /* best-effort release */ }
          }
          if (!imageUrl) throw new Error('视觉纠错图像缺失');
          const validationErrorDigest = pageIssues.map((issue) => issue.fingerprint).sort().join(',');
          const correctionIdentity: VisionPlanCacheIdentity = {
            fileHash: settings.sourceFileHash,
            pageIndex,
            modelId: VISION_LAYOUT_MODEL,
            promptVersion: VISION_CORRECTION_PROMPT_VERSION,
            renderVersion: VISION_RENDER_VERSION,
            renderScale: correctionRenderScale,
            protocolVersion: VISION_PAGE_PLAN_PROTOCOL_VERSION,
            parserVersion: VISION_LAYOUT_PARSER_VERSION,
            verifierVersion: VISION_LAYOUT_VERIFIER_VERSION,
            recoveryVersion: VISION_LAYOUT_RECOVERY_VERSION,
            canonicalizationVersion: VISION_PLAN_CANONICALIZATION_VERSION,
            round,
            basePlanDigest: patchBase.planDigest,
            validationErrorDigest,
          };
          let correction: Awaited<ReturnType<typeof requestVisionCorrection>> | undefined;
          let correctedPlan: VisionPagePlan | undefined;
          const callsBeforeRequest = correctionCallsUsed;
          const promptTokensBeforeRequest = correctionPromptTokens;
          const completionTokensBeforeRequest = correctionCompletionTokens;
          const patchCacheKey = buildVisionCorrectionPatchCacheKey(correctionIdentity);
          const recoveredCacheKey = buildRecoveredPagePlanCacheKey(correctionIdentity);
          try {
            const [patchArtifact, recoveredArtifact] = await Promise.all([
              options.repository.findArtifact(patchCacheKey),
              options.repository.findArtifact(recoveredCacheKey),
            ]);
            if (patchArtifact && recoveredArtifact) {
              const cached = replayCachedVisionCorrection({
                patchValue: JSON.parse(await patchArtifact.blob.text()),
                planValue: JSON.parse(await recoveredArtifact.blob.text()),
                patchBase,
                issues: pageIssues,
                round,
              });
              correction = {
                patch: cached.patch,
                usage: { promptTokens: 0, completionTokens: 0 },
                networkAttempts: 0,
              };
              correctedPlan = cached.plan;
            }
          } catch {
            // A correction is resumable only when its patch can be replayed
            // through the current atomic gate and exactly reproduces the
            // cached plan. Partial, stale, or corrupt pairs are cache misses.
            correction = undefined;
            correctedPlan = undefined;
          }
          if (!correction) {
            try {
              correction = await requestVisionCorrection({
                plan: patchBase,
                issues: pageIssues,
                round,
                imageUrl,
                localContext: correctionLocalContext,
                baseUrl: options.baseUrl ?? 'https://api.deepseek.com',
                apiKey,
                signal,
                maxAttempts: Math.min(2, maxCorrectionCalls - correctionCallsUsed) as 1 | 2,
                onAttemptStart: () => {
                  correctionCallsUsed += 1;
                  options.onAiEvent?.({
                    type: 'vision-correction-started', at: Date.now(), page: pageIndex + 1,
                    totalPages: pdf.numPages, round, correctionCallsUsed, maxCorrectionCalls,
                    errorCode: pageIssues[0]?.code ?? 'source-plan.unknown',
                    regionType: correctionRegionType,
                    repairAction,
                  });
                },
                validatePatch: (patch) => {
                  correctedPlan = applyVisionCorrectionPatch(patchBase, patch, { issues: pageIssues });
                },
                onAttemptResponse: ({ usage }) => {
                  correctionPromptTokens += usage.promptTokens;
                  correctionCompletionTokens += usage.completionTokens;
                },
                onRawResponse: async (response) => options.repository.putArtifact({
                  key: `${buildRawVisionResponseCacheKey(correctionIdentity)}:attempt-${response.attempt}`,
                  projectId: options.projectId,
                  kind: 'raw-vision-response',
                  blob: new Blob([JSON.stringify({
                    schemaVersion: 1, pageIndex, round, receivedAt: Date.now(), ...response,
                  })], { type: 'application/json' }),
                  updatedAt: Date.now(),
                  dependencies: { pageIndices: [pageIndex], cacheIdentityVersion: 'vision-cache-v1' },
                }),
              });
            } catch (error) {
              if (error instanceof CachePersistenceError) throw error;
              const requestError = safeErrorMessage(error, 240);
              sourceCorrectionAttempts.push({
                pageIndex,
                round,
                basePlanVersion: patchBase.planVersion,
                errorFingerprints: pageIssues.map((issue) => issue.fingerprint),
                outcome: 'request-failed',
                networkAttempts: correctionCallsUsed - callsBeforeRequest,
                promptTokens: correctionPromptTokens - promptTokensBeforeRequest,
                completionTokens: correctionCompletionTokens - completionTokensBeforeRequest,
                errorCode: error instanceof Error ? error.name : 'UnknownError',
                errorMessage: requestError,
              });
              await persistSourceLayoutReport(false, correctionIssues);
              throw new RecoverablePipelineError(
                error instanceof VisionPatchError
                  ? 'vision-protocol-retries-exhausted'
                  : 'network-retries-exhausted',
                `第 ${pageIndex + 1} 页视觉纠错请求失败：${requestError}。任务已暂停`,
                pausedVisionAttempt(
                  pageIndex,
                  round,
                  error instanceof VisionPatchError
                    ? 'transient.vision-protocol-retries-exhausted'
                    : 'transient.network-retries-exhausted',
                  requestError,
                ),
              );
            }
            await options.repository.putArtifact({
              key: patchCacheKey,
              projectId: options.projectId,
              kind: 'vision-correction-patch',
              blob: new Blob([JSON.stringify(correction.patch)], { type: 'application/json' }),
              updatedAt: Date.now(),
              dependencies: {
                pageIndices: [pageIndex], planVersion: patchBase.planVersion,
                cacheIdentityVersion: 'vision-cache-v1',
              },
            });
          }
          if (!correctedPlan) throw new Error('视觉补丁通过请求门后未产生已验证页面计划');
          sourceCorrectionAttempts.push({
            pageIndex,
            round,
            basePlanVersion: patchBase.planVersion,
            patchId: correction.patch.patchId,
            errorFingerprints: pageIssues.map((issue) => issue.fingerprint),
            outcome: 'patched',
            networkAttempts: correction.networkAttempts,
            promptTokens: correction.usage.promptTokens,
            completionTokens: correction.usage.completionTokens,
          });
          plansByPage.set(pageIndex, correctedPlan);
          await options.repository.putArtifact({
            key: buildRecoveredPagePlanCacheKey(correctionIdentity),
            projectId: options.projectId,
            kind: 'recovered-page-plan',
            blob: new Blob([JSON.stringify(correctedPlan)], { type: 'application/json' }),
            updatedAt: Date.now(),
            dependencies: {
              pageIndices: [pageIndex], planVersion: correctedPlan.planVersion,
              cacheIdentityVersion: 'vision-cache-v1',
            },
          });
          options.onAiEvent?.({
            type: 'vision-correction-completed', at: Date.now(), page: pageIndex + 1,
            totalPages: pdf.numPages, round, correctionCallsUsed, maxCorrectionCalls,
            promptTokens: correction.usage.promptTokens,
            completionTokens: correction.usage.completionTokens,
            regionType: correctionRegionType,
            repairAction,
          });
        }
        analyses = [...plansByPage.values()]
          .sort((left, right) => left.pageIndex - right.pageIndex)
          .map(planToVisionAnalysis);
        reconciled = reconcileVisionLayout(doc, analyses, 0.8, sourceBitmapRegions);
        for (const [pageIndex, plan] of plansByPage) {
          plansByPage.set(pageIndex, recoverLocallyRejectedRegions(plan, reconciled));
        }
        analyses = [...plansByPage.values()]
          .sort((left, right) => left.pageIndex - right.pageIndex)
          .map(planToVisionAnalysis);
        reconciled = reconcileVisionLayout(doc, analyses, 0.8, sourceBitmapRegions);
        correctionIssues = reconciliationValidationIssues(plansByPage, reconciled)
          .filter((issue) => reconciled.unresolved.some((item) => (
            item.pageIndex === issue.pageIndex
            && item.regionId === issue.regionId
            && isVisionCorrectableReason(item.reason)
          )));
        for (const pageIndex of pageIndices) {
          const before = issuesBeforeRound.filter((issue) => issue.pageIndex === pageIndex);
          const after = correctionIssues.filter((issue) => issue.pageIndex === pageIndex);
          const attempt = [...sourceCorrectionAttempts].reverse().find((item) => (
            item.pageIndex === pageIndex && item.round === round
          ));
          if (attempt) {
            attempt.outcome = after.length ? 'rejected' : 'accepted';
            attempt.errorFingerprints = after.map((issue) => issue.fingerprint);
          }
          if (!after.length) continue;
          const beforeFingerprint = before.map((issue) => issue.fingerprint).sort().join('|');
          const afterFingerprint = after.map((issue) => issue.fingerprint).sort().join('|');
          const reason = beforeFingerprint === afterFingerprint ? 'repeated-error' : 'no-improvement';
          if (!hasSubstantiveVisionCorrectionProgress(before, after)) {
            options.onAiEvent?.({
              type: 'vision-correction-stopped', at: Date.now(), page: pageIndex + 1,
              totalPages: pdf.numPages, round, reason,
              correctionCallsUsed, maxCorrectionCalls,
            });
            await persistSourceLayoutReport(false, correctionIssues);
            throw new RecoverablePipelineError(
              'vision-correction-budget-exhausted',
              `第 ${pageIndex + 1} 页视觉纠错没有解决现有结构错误，任务已暂停`,
              pausedVisionAttempt(
                pageIndex, round, 'source-plan.no-improvement', '视觉纠错没有解决现有结构错误',
              ),
            );
          }
        }
      }
      if (correctionIssues.length) {
        await persistSourceLayoutReport(false, correctionIssues);
        throw new RecoverablePipelineError(
          'vision-correction-budget-exhausted',
          `两轮视觉纠错后仍有 ${correctionIssues.length} 个结构错误，任务已暂停`,
          pausedVisionAttempt(
            correctionIssues[0]?.pageIndex ?? 0,
            2,
            'source-plan.correction-rounds-exhausted',
            '两轮视觉纠错后仍有结构错误',
          ),
        );
      }
      if (reconciled.unresolved.length) {
        const unresolvedIssues = reconciliationValidationIssues(plansByPage, reconciled);
        await persistSourceLayoutReport(false, unresolvedIssues);
        throw new RecoverablePipelineError(
          'source-layout-unresolved',
          `页面计划仍有待确认区域，任务已暂停：${reconciled.unresolved.map((item) => `第 ${item.pageIndex + 1} 页 ${item.reason}`).join('、')}`,
          pausedVisionAttempt(
            reconciled.unresolved[0]?.pageIndex ?? 0, lastCorrectionRound,
            'source-plan.unresolved', '区域识别证据不足，请检查诊断后重试',
          ),
        );
      }

      await Promise.all([...plansByPage.values()].map((plan) => {
        const acceptedPlan = withRecomputedPlanVersion({
          ...plan,
          regions: plan.regions.map((region) => ({ ...region, locked: true })),
        });
        plansByPage.set(plan.pageIndex, acceptedPlan);
        const key = buildAcceptedPagePlanCacheKey({
          fileHash: settings.sourceFileHash,
          pageIndex: plan.pageIndex,
          modelId: VISION_LAYOUT_MODEL,
          promptVersion: VISION_LAYOUT_PROMPT_VERSION,
          renderVersion: VISION_RENDER_VERSION,
          renderScale: plan.renderScale,
          protocolVersion: VISION_PAGE_PLAN_PROTOCOL_VERSION,
          parserVersion: VISION_LAYOUT_PARSER_VERSION,
          verifierVersion: VISION_LAYOUT_VERIFIER_VERSION,
          recoveryVersion: VISION_LAYOUT_RECOVERY_VERSION,
          canonicalizationVersion: VISION_PLAN_CANONICALIZATION_VERSION,
          round: 0,
        });
        return options.repository.putArtifact({
          key,
          projectId: options.projectId,
          kind: 'accepted-page-plan',
          blob: new Blob([JSON.stringify(acceptedPlan)], { type: 'application/json' }),
          updatedAt: Date.now(),
          dependencies: {
            pageIndices: [plan.pageIndex], planVersion: acceptedPlan.planVersion,
            cacheIdentityVersion: 'vision-cache-v1',
          },
        });
      }));
      const crossPage = validateCrossPageAssetCandidates(
        [...plansByPage.values()],
        inferCrossPageAssetCandidates([...plansByPage.values()]),
      );
      if (crossPage.issues.length) {
        throw new Error(`跨页资产关系门未通过：${crossPage.issues.map((item) => item.message).join('；')}`);
      }
      const crossPageGroupByMember = new Map(crossPage.groups.flatMap((group) => (
        group.members.map((member) => [`${member.pageIndex}:${member.regionId}`, group.id] as const)
      )));
      reconciled.assetRegions = reconciled.assetRegions.map((asset) => ({
        ...asset,
        crossPageAssetGroupId: crossPageGroupByMember.get(`${asset.pageIndex}:${asset.id}`),
      }));
      const acceptedDocumentPlanDigest = digestAcceptedDocumentPlan(
        [...plansByPage.values()], crossPage.groups,
      );
      await options.repository.putArtifact({
        key: `${options.projectId}:accepted-document-plan`,
        projectId: options.projectId,
        kind: 'accepted-document-plan',
        blob: new Blob([JSON.stringify({
          schemaVersion: 1,
          documentPlanDigest: acceptedDocumentPlanDigest,
          pagePlanDigests: [...plansByPage.values()]
            .sort((left, right) => left.pageIndex - right.pageIndex)
            .map((plan) => ({ pageIndex: plan.pageIndex, planDigest: plan.planDigest })),
          crossPageAssetGroups: crossPage.groups,
        })], { type: 'application/json' }),
        updatedAt: Date.now(),
        dependencies: {
          pageIndices: [...plansByPage.keys()].sort((left, right) => left - right),
          planVersion: acceptedDocumentPlanDigest,
          cacheIdentityVersion: 'vision-cache-v1',
        },
      });
      const sourceLayoutReport = await persistSourceLayoutReport(true, [], crossPage.groups);
      reportProgress?.({
        phase: 'structure-generation', totalPages: pdf.numPages,
        correctionRound: lastCorrectionRound, remainingPageRounds: 2 - lastCorrectionRound,
        validatedPages: pdf.numPages, failedPages: [], cachedPages: cachedPlanPages.size,
        correctionCallsUsed, maxCorrectionCalls,
        promptTokens: initialPromptTokens + correctionPromptTokens,
        completionTokens: initialCompletionTokens + correctionCompletionTokens,
      });
      const exactPortraitAssets = authorPortraitAssetsFromBitmapRegions(
        doc,
        current.sourceBitmapRegions ?? new Map<number, Rect[]>(),
      );
      if (exactPortraitAssets.length) {
        const overlapArea = (left: Rect, right: Rect) => Math.max(0, Math.min(
          left.x + left.w,
          right.x + right.w,
        ) - Math.max(left.x, right.x)) * Math.max(0, Math.min(
          left.y + left.h,
          right.y + right.h,
        ) - Math.max(left.y, right.y));
        reconciled.assetRegions = reconciled.assetRegions.filter((asset) => (
          asset.kind !== 'figure'
          || Boolean(asset.captionUnitId)
          || !exactPortraitAssets.some((portrait) => (
            portrait.pageIndex === asset.pageIndex
            && overlapArea(portrait.rect, asset.rect) / Math.max(1, portrait.rect.w * portrait.rect.h) >= 0.2
          ))
        ));
        reconciled.assetRegions.push(...exactPortraitAssets);
      }
      if (import.meta.env.MODE === 'test') {
        (globalThis as typeof globalThis & { __PP_DIAGNOSTIC_LAYOUT__?: unknown })
          .__PP_DIAGNOSTIC_LAYOUT__ = {
            pages: doc.pages,
            blocks: doc.blocks.map(({ characterRects: _characters, ...block }) => block),
            semanticUnits: doc.semanticUnits,
            layoutRegions: doc.layoutRegions,
            analyses,
            reconciled,
          };
      }
      reconciled.unresolved.forEach((item) => options.onAiEvent?.({
        type: 'vision-layout-fallback', at: Date.now(), page: item.pageIndex + 1,
        region: item.regionIndex + 1, reason: item.reason,
      }));
      const prepared = prepareImmutableStructure(doc, {
        verifiedAssetRegions: reconciled.assetRegions,
        fontFormulaRegions: current.sourceFontFormulas as ReturnType<typeof detectFontFormulaRegions> | undefined,
        pageLayouts: new Map(analyses.map((analysis) => [analysis.pageIndex, analysis.layout])),
      });
      assertPreparedStructure({
        stage: 'pre-translation',
        regions: prepared.regions,
        units: prepared.units,
        assets: prepared.assetRegions,
      });
      if (import.meta.env.MODE === 'test') {
        const diagnosticGlobal = globalThis as typeof globalThis & { __PP_DIAGNOSTIC_LAYOUT__?: unknown };
        diagnosticGlobal.__PP_DIAGNOSTIC_LAYOUT__ = {
          ...(diagnosticGlobal.__PP_DIAGNOSTIC_LAYOUT__ as Record<string, unknown> ?? {}),
          prepared: {
            regions: prepared.regions,
            units: prepared.units,
            assetRegions: prepared.assetRegions,
          },
        };
      }
      const assetRegions = prepared.assetRegions.map((region) => ({ ...region }));
      const formulaRegions = assetRegions.filter((region) => (
        region.kind === 'formula' && region.geometrySource !== 'font-runs' && Boolean(region.preserveRects?.length)
      ));
      let nextFormula = 0;
      const reconstructFormula = async (): Promise<void> => {
        while (nextFormula < formulaRegions.length) {
          signal.throwIfAborted();
          const formula = formulaRegions[nextFormula]!;
          nextFormula += 1;
          const cacheKey = buildFormulaOcrCacheKey({
            fileHash: settings.sourceFileHash,
            pageIndex: formula.pageIndex,
            regionId: formula.id,
            modelId: FORMULA_OCR_MODEL,
            promptVersion: `${FORMULA_OCR_PROMPT_VERSION}:${ASSET_CROP_RENDER_VERSION}`,
            sourceRect: [formula.rect.x, formula.rect.y, formula.rect.w, formula.rect.h]
              .map((number) => number.toFixed(3)).join(','),
          });
          const cached = await options.repository.findArtifact(cacheKey);
          const cachedResult = cached
            ? parseCachedFormulaOcrResult(await cached.blob.text())
            : undefined;
          const recognized = cachedResult
            ?? await recognizeFormulaCrop({
              blob: await cropPageRegionLossless(
                await awaitWithDeadline(pdf.getPage(formula.pageIndex + 1), {
                  signal, timeoutMs: 30_000, timeoutMessage: `读取第 ${formula.pageIndex + 1} 页公式超时`,
                }),
                formula.rect,
                6,
                undefined,
                undefined,
                { signal },
              ),
              baseUrl: options.baseUrl ?? 'https://api.deepseek.com',
              apiKey,
              formulaHint: formula.formulaHint,
              requiresLargeOperator: formula.requiresLargeOperator,
              signal,
            });
          if (!cachedResult) {
            await options.repository.putArtifact({
              key: cacheKey,
              projectId: options.projectId,
              kind: 'formula-ocr',
              blob: new Blob([JSON.stringify(recognized)], { type: 'application/json' }),
              updatedAt: Date.now(),
              dependencies: {
                pageIndices: [formula.pageIndex],
                sourceUnitIds: [formula.id],
                cacheIdentityVersion: 'formula-ocr-v1',
              },
            });
          }
          const rendered = await renderLatexFormulaPng(recognized.latex);
          formula.rawImage = {
            bytes: new Uint8Array(await rendered.arrayBuffer()),
            mimeType: 'image/png',
          };
        }
      };
      await Promise.all(Array.from(
        { length: Math.min(2, formulaRegions.length) },
        () => reconstructFormula(),
      ));
      const assets = await extractImmutableAssets(assetRegions, {
        signal,
        crop: async (region, cropSignal) => cropPageRegionLossless(
          await awaitWithDeadline(pdf.getPage(region.pageIndex + 1), {
            signal: cropSignal, timeoutMs: 30_000, timeoutMessage: `读取第 ${region.pageIndex + 1} 页图表超时`,
          }),
          region.rect,
          4,
          region.eraseRects,
          region.preserveRects,
          { signal: cropSignal },
        ),
      });
      return {
        ...current,
        settings: {
          ...settings,
          maxVisionCorrectionCalls: maxCorrectionCalls > 0 ? maxCorrectionCalls : undefined,
        },
        prepared,
        assets,
        crossPageAssetGroups: crossPage.groups,
        sourceLayoutReport,
        acceptedDocumentPlanDigest,
        visionAttempt: {
          phase: 'structure-generation',
          totalPages: pdf.numPages,
          correctionRound: lastCorrectionRound,
          remainingPageRounds: 2 - lastCorrectionRound,
          validatedPages: pdf.numPages,
          failedPages: [],
          cachedPages: cachedPlanPages.size,
          correctionCallsUsed,
          maxCorrectionCalls,
          promptTokens: initialPromptTokens + correctionPromptTokens,
          completionTokens: initialCompletionTokens + correctionCompletionTokens,
        },
      };
    },

    async buildGlossary(input) {
      const current = value(input);
      const doc = requireValue(current.doc, '解析文档缺失');
      const prepared = requireValue(current.prepared, '版式结构缺失');
      const glossary = current.glossary ?? [];
      const requests = buildTranslationRequestsFromDoc({ ...doc, semanticUnits: prepared.units });
      return { ...current, glossary, requests, requiredBlocks: requests.length };
    },

    async translate(input, signal, reportProgress) {
      const current = value(input);
      const doc = requireValue(current.doc, '解析文档缺失');
      const glossary = current.glossary ?? [];
      const requests = requireValue(current.requests, '翻译请求缺失');
      const limits = translationLimitsFor(settings.thinkingMode);
      const batches = buildTranslationBatches(requests, {
        maxInputTokens: limits.maxInputTokens,
        maxBlocks: limits.maxBlocks,
        documentContext: { title: doc.meta.title, layoutMode: doc.layoutMode },
        glossary,
      });
      if (!apiKey.trim()) throw new Error('DeepSeek API Key 不存在，请返回上传页重新验证');
      const cacheKey = (block: TranslationBlockRequest) => buildTranslationCacheKey({
        fileHash: settings.sourceFileHash,
        promptVersion: SYSTEM_PROMPT_VERSION,
        modelId: settings.modelId,
        thinkingMode: settings.thinkingMode,
        glossaryHash: JSON.stringify(glossary),
        blockId: block.blockId,
        sourceText: block.source,
        protectedTokens: block.protectedTokens,
      });
      const streamHeartbeat = new Map<string, { at: number; phase: 'connected' | 'reasoning' | 'content' }>();
      const result = await runTranslationTask({
        projectId: options.projectId,
        modelId: settings.modelId,
        batches,
        concurrency: options.concurrency ?? 2,
        maxRetries: options.maxRetries ?? 2,
        signal,
        request: async (batch, batchSignal) => {
          const requestThinkingMode = batch.recovery?.disableThinking ? 'disabled' : settings.thinkingMode;
          const repairPlan = batch.recovery?.reason === 'validation' && batch.blocks.length === 1
            ? buildSingleBlockRepairPlan(batch.blocks[0]!)
            : undefined;
          const protectedMask = maskProtectedTokensForTranslation(repairPlan?.blocks ?? batch.blocks);
          const requestBody: TranslationRequest = {
            documentContext: {
              title: doc.meta.title ?? settings.sourceFileName,
              abstract: doc.semanticUnits.find((unit) => unit.kind === 'abstract')?.sourceText,
              detectedFields: [], sectionPath: '',
            },
            terminologyPolicy: {
              firstOccurrence: '中文名称（English Full Name, ABBR）',
              laterOccurrence: '固定译名或缩写',
            },
            entityPolicy: { authorNames: 'keep', organizationNames: 'translate_when_clear', modelNames: 'keep', productNames: 'keep' },
            glossary,
            ...(batch.recovery ? {
              recoveryContext: {
                reason: batch.recovery.reason,
                validationCodes: batch.recovery.validationCodes ?? [],
                validationDetails: batch.recovery.validationDetails ?? [],
              },
            } : {}),
            blocks: protectedMask.blocks,
          };
          const recoveryInstruction = buildTranslationRecoveryInstruction(requestBody.recoveryContext);
          const completion = await chatCompletion({
            baseUrl: options.baseUrl ?? 'https://api.deepseek.com',
            apiKey, model: settings.modelId, thinkingMode: requestThinkingMode,
            responseFormat: 'json_object', signal: batchSignal, timeoutMs: 120_000, hardTimeoutMs: 300_000,
            maxTokens: translationLimitsFor(requestThinkingMode).maxOutputTokens,
            stream: true,
            onStreamProgress: (progress) => {
              const at = Date.now();
              const previous = streamHeartbeat.get(batch.id);
              if (previous && previous.phase === progress.phase && at - previous.at < 2_000) return;
              streamHeartbeat.set(batch.id, { at, phase: progress.phase });
              options.onAiEvent?.({
                type: 'batch-progress', at, batchId: batch.id,
                phase: progress.phase, receivedContentChars: progress.receivedContentChars,
              });
            },
            messages: [
              { role: 'system', content: [buildSystemPrompt(), recoveryInstruction].filter(Boolean).join('\n') },
              { role: 'user', content: buildBatchPrompt(requestBody) },
            ],
          });
          const normalized = normalizeDeepSeekTranslationResponse(parseDeepSeekTranslationJson(completion.content));
          const restored = restoreProtectedTokensFromTranslation(
            normalized,
            protectedMask.replacements,
            protectedMask.blocks,
          );
          const merged = repairPlan ? repairPlan.merge(restored) : restored;
          return {
            ...restoreMissingProtectedTokensFromTranslation(batch.blocks, merged),
            usage: completion.usage,
          };
        },
        findCached: async (block) => {
          const cached = await options.repository.findTranslation(cacheKey(block));
          if (!cached) return undefined;
          const normalizedCached = restoreMissingProtectedTokensFromTranslation([block], { blocks: [{
            blockId: cached.blockId, translation: cached.translation,
            alignmentGroups: cached.alignmentGroups, newTerms: [], warnings: [],
          }] });
          return normalizedCached.blocks[0];
        },
        saveValidated: async (record) => options.repository.putTranslation({
          key: cacheKey(requests.find((request) => request.blockId === record.blockId)!),
          projectId: options.projectId, blockId: record.blockId,
          translation: record.translation, alignmentGroups: record.alignmentGroups, validatedAt: Date.now(),
        }),
        validateAccepted: (record, request, committedMarkerIds) => {
          const validation = validateTranslationBlockMarkers({
            request, response: record, committedMarkerIds,
          });
          if (validation.issues.length) throw new MarkerInvariantError(validation.issues);
          return validation.markerIds;
        },
        isNonRetryableError: (error) => error instanceof MarkerInvariantError
          || error instanceof CachePersistenceError,
        onEvent: (event) => {
          options.onAiEvent?.(event);
          if (event.type === 'batch-validated') {
            reportProgress?.({ type: 'validated', count: event.blockIds.length });
          } else if (event.type === 'cache-hit') {
            reportProgress?.({ type: 'validated', count: 1 });
          } else if (event.type === 'retry') {
            reportProgress?.({ type: 'retry', count: 1 });
          } else if (event.type === 'error') {
            reportProgress?.({ type: 'failed', count: event.blockIds.length });
          }
        },
      });
      return {
        ...current, requests, translations: result.translations,
        requiredBlocks: requests.length, validatedBlocks: result.completedBlockIds.length,
      };
    },

    async compose(input) {
      const current = value(input);
      const doc = requireValue(current.doc, '解析文档缺失');
      const prepared = requireValue(current.prepared, '版式结构缺失');
      const requests = requireValue(current.requests, '翻译请求缺失');
      const translations = requireValue(current.translations, '翻译结果缺失');
      assertPreparedStructure({
        stage: 'pre-typst',
        regions: prepared.regions,
        units: prepared.units,
        assets: prepared.assetRegions,
      });
      const responseById = new Map(translations.map((response) => [response.blockId, response]));
      const requestById = new Map(requests.map((request) => [request.blockId, request]));
      const flowGroups = paragraphFlowGroups(prepared.units, prepared.regions, doc.blocks);
      const typstUnits: TypstSemanticUnit[] = prepared.units.map((unit) => {
        const sourceColumn = typstSourceColumn(unit, doc, current.assets ?? []);
        const flowGroupId = flowGroups.get(unit.id);
        if (unit.assetId) return {
          id: unit.id, kind: unit.kind, layoutRegionId: unit.layoutRegionId,
          order: unit.order, assetId: unit.assetId, sourceColumn, flowGroupId,
          crossPageAssetGroupId: unit.crossPageAssetGroupId,
          headingLevel: unit.headingLevel, headingNumber: unit.headingNumber,
        };
        if (unit.kind === 'reference' || unit.kind === 'author') return {
          id: unit.id, kind: unit.kind, layoutRegionId: unit.layoutRegionId,
          order: unit.order, text: unit.sourceText ?? '', sourceColumn,
          headingLevel: unit.headingLevel, headingNumber: unit.headingNumber,
        };
        return {
          ...typstTextUnit(
          unit,
          requireValue(requestById.get(unit.id), `缺少翻译请求 ${unit.id}`),
          requireValue(responseById.get(unit.id), `缺少翻译结果 ${unit.id}`),
          ),
          sourceColumn, flowGroupId,
        };
      });
      const requiredMarkerIds = typstUnits.flatMap((unit) => (
        unit.targetSegments?.length
          ? unit.targetSegments.map((segment) => segment.id)
          : [unit.id]
      ));
      const preTypstMarkerIssues = validateGlobalMarkers({
        requiredMarkerIds,
        emittedMarkerIds: requiredMarkerIds,
      });
      if (preTypstMarkerIssues.length) throw new MarkerInvariantError(preTypstMarkerIssues);
      const typstProject = await buildTypstProject({
        metadata: { paperWidth: doc.meta.paperWidth, paperHeight: doc.meta.paperHeight },
        regions: prepared.regions,
        units: typstUnits,
        assets: current.assets ?? [],
        targetLayoutPolicy,
        crossPageAssetGroups: current.crossPageAssetGroups,
      });
      const markerIssues = validateGlobalMarkers({
        requiredMarkerIds,
        emittedMarkerIds: typstProject.markerIds,
      });
      if (markerIssues.length) throw new MarkerInvariantError(markerIssues);
      if (import.meta.env.MODE === 'test') {
        (globalThis as typeof globalThis & { __PP_DIAGNOSTIC_TYPST_SOURCE__?: string })
          .__PP_DIAGNOSTIC_TYPST_SOURCE__ = typstProject.mainContent;
      }
      return { ...current, typstProject, typstUnits };
    },

    async compile(input, signal) {
      const current = value(input);
      const project = requireValue(current.typstProject, 'Typst 项目缺失');
      const compiled = await compileTypstProject(project, {
        runtimePaths: getTypstRuntimePaths(import.meta.env.BASE_URL, document.baseURI), signal,
        onProgress: (phase) => options.onCompileProgress?.(phase),
      });
      options.onPreview?.({ svg: compiled.svg, attempt: 0 });
      if (import.meta.env.MODE === 'test') {
        const debugGlobal = globalThis as typeof globalThis & { __PP_DIAGNOSTIC_PDF_URL__?: string };
        if (debugGlobal.__PP_DIAGNOSTIC_PDF_URL__) URL.revokeObjectURL(debugGlobal.__PP_DIAGNOSTIC_PDF_URL__);
        debugGlobal.__PP_DIAGNOSTIC_PDF_URL__ = URL.createObjectURL(
          new Blob([new Uint8Array(compiled.pdf)], { type: 'application/pdf' }),
        );
      }
      return { ...current, compiled };
    },

    async align(input) {
      const current = value(input);
      const compiled = requireValue(current.compiled, '中文 PDF 缺失');
      const manifest = await buildAlignmentForCompiled(current, compiled, options.projectId);
      if (import.meta.env.MODE === 'test') {
        (globalThis as typeof globalThis & { __PP_DIAGNOSTIC_ALIGNMENT_MANIFEST__?: AlignmentManifest })
          .__PP_DIAGNOSTIC_ALIGNMENT_MANIFEST__ = manifest;
      }
      return { ...current, manifest };
    },

    async validate(input, signal) {
      const current = value(input);
      const doc = requireValue(current.doc, '解析文档缺失');
      const translations = requireValue(current.translations, '翻译结果缺失');
      const prepared = requireValue(current.prepared, '版式结构缺失');
      const typstUnits = requireValue(current.typstUnits, 'Typst 语义单元缺失');
      let compiled = requireValue(current.compiled, '中文 PDF 缺失');
      let manifest = requireValue(current.manifest, '对齐清单缺失');
      let project = requireValue(current.typstProject, 'Typst 项目缺失');
      const sourcePdf = requireValue(current.sourcePdf, '源 PDF 缺失');
      const sourceLayoutReport = requireValue(current.sourceLayoutReport, '源版式质量报告缺失');
      const acceptedDocumentPlanDigest = requireValue(
        current.acceptedDocumentPlanDigest,
        '已接受文档计划摘要缺失',
      );
      const attemptReports: QualityAttemptReport[] = [];
      const readableFirst = settings.qualityPolicy === 'readable-first';
      let repairPlan: LayoutRepairPlan | undefined;
      const report = (pass: boolean): QualityReport => {
        const qualityReport: QualityReport = {
          schemaVersion: 2,
          projectId: options.projectId,
          layoutProfileVersion: settings.layoutProfileVersion ?? 'legacy-source-layout',
          pass,
          createdAt: Date.now(),
          attempts: attemptReports,
          sourceLayout: sourceLayoutReport,
          alignmentIssues: runAlignmentGate(manifest).issues,
        };
        if (import.meta.env.MODE === 'test') {
          (globalThis as typeof globalThis & { __PP_DIAGNOSTIC_QUALITY_REPORT__?: QualityReport })
            .__PP_DIAGNOSTIC_QUALITY_REPORT__ = qualityReport;
        }
        return qualityReport;
      };
      const compileWithRepair = async (
        nextPlan: LayoutRepairPlan,
        nextAttempt: 1 | 2,
        issueCount: number,
      ): Promise<void> => {
        repairPlan = nextPlan;
        options.onAiEvent?.({
          type: 'layout-repair-started', at: Date.now(), attempt: nextAttempt, issueCount,
        });
        repairPlan.actions.forEach((action) => options.onAiEvent?.({
          type: 'layout-repair-action', at: Date.now(), attempt: nextAttempt,
          unitId: action.unitId, message: action.detail,
        }));
        project = await buildTypstProject({
          metadata: { paperWidth: doc.meta.paperWidth, paperHeight: doc.meta.paperHeight },
          regions: prepared.regions,
          units: typstUnits,
          assets: current.assets ?? [],
          targetLayoutPolicy,
          repairPlan,
          crossPageAssetGroups: current.crossPageAssetGroups,
        });
        compiled = await compileTypstProject(project, {
          runtimePaths: getTypstRuntimePaths(import.meta.env.BASE_URL, document.baseURI), signal,
          onProgress: (phase) => options.onCompileProgress?.(phase),
        });
        options.onPreview?.({ svg: compiled.svg, attempt: nextAttempt });
        manifest = await buildAlignmentForCompiled(current, compiled, options.projectId);
        current.typstProject = project;
        current.compiled = compiled;
        current.manifest = manifest;
        if (import.meta.env.MODE === 'test') {
          (globalThis as typeof globalThis & { __PP_DIAGNOSTIC_TYPST_SOURCE__?: string })
            .__PP_DIAGNOSTIC_TYPST_SOURCE__ = project.mainContent;
        }
        options.onAiEvent?.({ type: 'layout-repair-completed', at: Date.now(), attempt: nextAttempt });
      };
      for (let attempt = 0 as 0 | 1 | 2; attempt <= 2; attempt = (attempt + 1) as 0 | 1 | 2) {
          if (signal.aborted) throw new DOMException('已停止', 'AbortError');
          const alignment = runAlignmentGate(manifest);
          const pdfCompiled = new TextDecoder().decode(compiled.pdf.slice(0, 5)).startsWith('%PDF-');
          const inspection = await inspectCompiledPdf(compiled.pdf);
          const contentGate = runPdfContentGate({
            ...inspection,
            expectedTranslations: translations.map((translation) => translation.translation),
            maximumPages: Math.max(doc.pageCount + 2, Math.ceil(doc.pageCount * 3)),
          });
          if (!alignment.pass && !readableFirst) {
            await persistQualityReport(options.repository, report(false));
            const errors = alignment.issues.filter((issue) => issue.severity === 'error');
            throw new Error(`对齐质量门未通过：${errors.map((issue) => issue.message).join('；')}`);
          }
          if (!contentGate.pass) {
            const nonRepairableIssues = contentGate.issues
              .filter((issue) => issue.code !== 'asset-footer-overflow');
            if (nonRepairableIssues.length) {
              await persistQualityReport(options.repository, report(false));
              throw new Error(`PDF 内容质量门未通过：${contentGate.issues.map((issue) => issue.message).join('；')}`);
            }
            const overflowIssues: VisionFinalIssue[] = findAssetFooterOverflows(
              inspection.pageBitmapRegions,
              inspection.pageSizes,
            ).map(({ pageIndex, rect, page }) => ({
              targetPageIndex: pageIndex,
              type: 'overlap',
              severity: 'severe',
              bbox: [
                Math.max(0, Math.min(1000, rect.x / page.width * 1000)),
                Math.max(0, Math.min(1000, rect.y / page.height * 1000)),
                Math.max(0, Math.min(1000, rect.w / page.width * 1000)),
                Math.max(0, Math.min(1000, rect.h / page.height * 1000)),
              ],
              confidence: 1,
              evidence: 'Immutable asset crosses the printable bottom and footer boundary',
            }));
            attemptReports.push({
              attempt,
              pass: false,
              reviewedPages: 0,
              issues: overflowIssues,
              actions: repairPlan?.actions ?? [],
            });
            if (attempt === 2) {
              await persistQualityReport(options.repository, report(false));
              throw new Error('PDF 内容质量门未通过：两轮自动修复后图片仍越过正文底线');
            }
            const nextAttempt = (attempt + 1) as 1 | 2;
            const nextPlan = buildLayoutRepairPlan({
              attempt: nextAttempt,
              issues: overflowIssues,
              manifest,
              units: typstUnits,
              pageSizes: new Map(inspection.pageSizes.map((page, pageIndex) => [pageIndex, page])),
              previous: repairPlan,
            });
            if (!nextPlan) {
              await persistQualityReport(options.repository, report(false));
              throw new Error('PDF 内容质量门未通过且没有可安全映射的图片排版修复动作');
            }
            await compileWithRepair(nextPlan, nextAttempt, overflowIssues.length);
            continue;
          }

          const targetLoading = getDocument({ data: compiled.pdf.slice() });
          const targetPdf = await targetLoading.promise;
          const pageSizes = new Map<number, PdfPageSize>();
          let visualReport: VisionFinalReport;
          let finalReviewPageIndex = 0;
          let finalReviewedPages = 0;
          try {
            for (let pageIndex = 0; pageIndex < targetPdf.numPages; pageIndex += 1) {
              const page = await targetPdf.getPage(pageIndex + 1);
              const viewport = page.getViewport({ scale: 1 });
              pageSizes.set(pageIndex, { width: viewport.width, height: viewport.height });
            }
            try {
              visualReport = skipRemoteFinalReview
                ? { pass: true, issues: [], reviewedPages: targetPdf.numPages }
                : await runVisionFinalReview({
              sourcePdf,
              targetPdf: targetPdf as any,
              manifest,
              baseUrl: options.baseUrl ?? 'https://api.deepseek.com',
              apiKey,
              targetLayoutPolicy,
              signal,
              onPageStart: (event) => {
                finalReviewPageIndex = event.targetPageIndex;
                options.onAiEvent?.({
                  type: 'vision-review-page-started', at: Date.now(), page: event.targetPageIndex + 1,
                  totalPages: event.totalPages,
                });
              },
              onPagePhase: (event) => options.onAiEvent?.({
                type: 'vision-review-page-phase', at: Date.now(), page: event.targetPageIndex + 1,
                totalPages: event.totalPages, phase: event.phase,
              }),
              onPageInvalid: (event) => options.onAiEvent?.({
                type: 'vision-review-page-invalid', at: Date.now(), page: event.targetPageIndex + 1,
                totalPages: event.totalPages, reason: event.reason,
              }),
              onPageWait: (event) => options.onAiEvent?.({
                type: 'vision-review-page-waiting', at: Date.now(), page: event.targetPageIndex + 1,
                totalPages: event.totalPages, elapsedMs: event.elapsedMs,
              }),
              onPageTimeout: (event) => options.onAiEvent?.({
                type: 'vision-review-page-timeout', at: Date.now(), page: event.targetPageIndex + 1,
                totalPages: event.totalPages, timeoutMs: event.timeoutMs,
              }),
              onPage: (event) => {
                finalReviewedPages += 1;
                options.onAiEvent?.({
                  type: 'vision-review-page', at: Date.now(), page: event.targetPageIndex + 1,
                  totalPages: event.totalPages, issueCount: event.issueCount,
                });
              },
              });
            } catch (error) {
              if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
              if (isNonRetryableDeepSeekAccountError(error)) throw error;
              const protocolFailure = error instanceof Error && error.message.startsWith('Vision 成品质检');
              const transportFailure = isRetryableDeepSeekTransportError(error);
              if (!protocolFailure && !transportFailure) throw error;
              const previous = current.visionAttempt;
              throw new RecoverablePipelineError(
                protocolFailure ? 'vision-protocol-retries-exhausted' : 'network-retries-exhausted',
                `V4.1 Flash 成品质检第 ${finalReviewPageIndex + 1} 页连续${protocolFailure ? '返回无效协议' : '请求失败'}，任务已暂停`,
                {
                  phase: 'final-review',
                  pageIndex: finalReviewPageIndex,
                  totalPages: targetPdf.numPages,
                  correctionRound: previous?.correctionRound ?? 0,
                  remainingPageRounds: previous?.remainingPageRounds ?? 2,
                  validatedPages: finalReviewedPages,
                  failedPages: [finalReviewPageIndex],
                  cachedPages: previous?.cachedPages ?? 0,
                  correctionCallsUsed: previous?.correctionCallsUsed ?? 0,
                  maxCorrectionCalls: previous?.maxCorrectionCalls ?? 0,
                  promptTokens: previous?.promptTokens ?? 0,
                  completionTokens: previous?.completionTokens ?? 0,
                  errorCode: protocolFailure
                    ? 'final-pdf.vision-protocol-retries-exhausted'
                    : 'final-pdf.network-retries-exhausted',
                  errorMessage: protocolFailure ? '成品质检响应协议连续失败' : '成品质检网络请求连续失败',
                },
              );
            }
          } finally {
            await targetPdf.destroy();
          }
          if (import.meta.env.MODE === 'test') {
            (globalThis as typeof globalThis & { __PP_DIAGNOSTIC_VISUAL_REPORT__?: VisionFinalReport })
              .__PP_DIAGNOSTIC_VISUAL_REPORT__ = visualReport;
          }
          options.onAiEvent?.({
            type: 'vision-review-completed', at: Date.now(), reviewedPages: visualReport.reviewedPages,
            issueCount: visualReport.issues.length,
          });
          const severeVisualIssues = visualReport.issues.filter(isBlockingVisionFinalIssue);
          attemptReports.push({
            attempt,
            pass: visualReport.pass,
            reviewedPages: visualReport.reviewedPages,
            issues: visualReport.issues,
            actions: repairPlan?.actions ?? [],
          });
          options.onAiEvent?.({
            type: 'quality-finalizing', at: Date.now(), visualPass: visualReport.pass,
            severeIssueCount: severeVisualIssues.length,
            pendingReview: readableFirst && (!visualReport.pass || !alignment.pass),
          });
          const visualError = severeVisualIssues.map((issue) => (
            `第 ${issue.targetPageIndex + 1} 页 ${issue.type}：${issue.evidence}`
          )).join('；');

          if (visualReport.pass || readableFirst) {
            const updatedAt = Date.now();
            const qualityReport = report(visualReport.pass && alignment.pass);
            qualityReport.deliveryStatus = qualityReport.pass ? 'verified' : 'needs-review';
            const artifacts = [
              {
                key: `${options.projectId}:chinese-pdf`, projectId: options.projectId,
                kind: 'chinese-pdf' as const, blob: new Blob([new Uint8Array(compiled.pdf)], { type: 'application/pdf' }), updatedAt,
              },
              {
                key: `${options.projectId}:typst-source`, projectId: options.projectId,
                kind: 'typst-source' as const, blob: new Blob([project.mainContent], { type: 'text/plain' }), updatedAt,
              },
              {
                key: `${options.projectId}:typst-preview`, projectId: options.projectId,
                kind: 'typst-preview' as const, blob: new Blob([compiled.svg], { type: 'image/svg+xml' }), updatedAt,
              },
              {
                key: `${options.projectId}:quality-report`, projectId: options.projectId,
                kind: 'quality-report' as const,
                blob: new Blob([JSON.stringify(qualityReport, null, 2)], { type: 'application/json' }), updatedAt,
              },
            ];
            await persistValidatedOutputs({
              contentGate,
              alignmentPass: alignment.pass,
              alignmentError: alignment.issues.map((issue) => issue.message).join('；'),
              visualPass: visualReport.pass,
              visualError,
              qualityPolicy: settings.qualityPolicy,
              artifacts,
              manifest,
              commit: (validatedArtifacts, validatedManifest) => options.repository.commitValidatedOutputs({
                projectId: options.projectId,
                expectedDocumentPlanDigest: acceptedDocumentPlanDigest,
                artifacts: validatedArtifacts,
                manifest: validatedManifest,
              }),
            });
            options.onAiEvent?.({ type: 'quality-persisted', at: Date.now() });
            const persisted = Boolean(
              await options.repository.findArtifact(`${options.projectId}:chinese-pdf`)
              && await options.repository.loadAlignmentManifest(options.projectId),
            );
            return {
              requiredBlocks: current.requiredBlocks ?? 0,
              validatedBlocks: current.validatedBlocks ?? 0,
              failedBlocks: 0,
              protectedContentPass: true,
              pdfCompiled,
              assetsPass: contentGate.pass,
              alignmentBuilt: alignment.pass || readableFirst,
              persisted,
            };
          }

          if (attempt === 2) {
            await persistQualityReport(options.repository, report(false));
            throw new Error(`视觉质检未通过：${visualError || '两轮自动修复后仍有严重页面缺陷'}`);
          }
          const nextAttempt = (attempt + 1) as 1 | 2;
          const nextPlan = buildLayoutRepairPlan({
            attempt: nextAttempt,
            issues: severeVisualIssues,
            manifest,
            units: typstUnits,
            pageSizes,
            previous: repairPlan,
          });
          if (!nextPlan) {
            await persistQualityReport(options.repository, report(false));
            throw new Error(`视觉质检未通过且没有安全的自动修复动作：${visualError || '内容完整性问题'}`);
          }
          await compileWithRepair(nextPlan, nextAttempt, severeVisualIssues.length);
      }
      throw new Error('质量检查未完成');
    },

    async dispose(input) {
      const current = value(input);
      await (current.sourcePdf as { destroy?: () => Promise<unknown> } | undefined)?.destroy?.();
    },
  };
}
