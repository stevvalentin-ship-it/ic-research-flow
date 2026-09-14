import type {
  CharacterRect,
  Doc,
  LayoutRegion,
  Rect,
  SemanticUnit,
  SemanticUnitKind,
} from '../../types/models';
import type { DetectedAssetRegion } from '../assets/extract';
import type { FontFormulaRegion } from '../pdf/formulaRegions';
import { validateImmutableRegion } from '../assets/geometryGate';
import { buildSourceSentenceCandidates } from '../align/sourceSentences';
import { extractProtectedTokens } from '../translate/protected';
import { isFigureCaptionText, isTableCaptionText } from '../parser/blocks';
import type {
  TranslationBlockKind,
  TranslationBlockRequest,
  TranslationResponse,
} from '../translate/protocol';

const IMMUTABLE_KINDS = new Set<SemanticUnitKind>([
  'figure', 'table', 'formula', 'code', 'page-furniture',
]);

function isAuthorBiographyPage(doc: Doc, pageIndex: number): boolean {
  const text = doc.blocks
    .filter((block) => block.pageIndex === pageIndex)
    .map((block) => block.text ?? '')
    .join('\n');
  return (text.match(/\breceived\b[\s\S]{0,160}?\bdegree\b/gi) ?? []).length >= 3;
}

function isPortraitAsset(doc: Doc, asset: DetectedAssetRegion): boolean {
  if (asset.kind !== 'figure' || asset.captionUnitId) return false;
  const page = doc.pages[asset.pageIndex];
  if (!page) return false;
  const widthRatio = asset.rect.w / page.width;
  const heightRatio = asset.rect.h / page.height;
  const aspect = asset.rect.w / Math.max(1, asset.rect.h);
  return widthRatio >= 0.08 && widthRatio <= 0.22
    && heightRatio >= 0.08 && heightRatio <= 0.22
    && aspect >= 0.55 && aspect <= 1.5;
}

function authorPortraitPages(doc: Doc, assets: readonly DetectedAssetRegion[]): Set<number> {
  const counts = new Map<number, number>();
  for (const asset of assets) {
    if (!isPortraitAsset(doc, asset) || !isAuthorBiographyPage(doc, asset.pageIndex)) continue;
    counts.set(asset.pageIndex, (counts.get(asset.pageIndex) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count >= 3).map(([pageIndex]) => pageIndex));
}

function translationKind(kind: SemanticUnitKind): TranslationBlockKind {
  if (kind === 'author') return 'author';
  if (kind === 'affiliation') return 'affiliation';
  if (kind === 'abstract') return 'abstract';
  if (kind === 'keywords') return 'paragraph';
  if (kind === 'heading') return 'heading';
  if (kind === 'list-item') return 'list-item';
  if (kind === 'caption') return 'caption';
  if (kind === 'table-title') return 'table-title';
  if (kind === 'title') return 'title';
  return 'paragraph';
}

export function buildTranslationRequestsFromDoc(doc: Doc): TranslationBlockRequest[] {
  return [...doc.semanticUnits]
    .sort((left, right) => left.order - right.order)
    // Author names are document identity, not translatable prose. A model-side
    // `authorNames: keep` hint is not a sufficient invariant: models can still
    // transliterate or localize a name. Keep author units out of the API
    // request entirely and render their source text verbatim, just like
    // references and immutable technical assets.
    .filter((unit) => (
      unit.kind !== 'author'
      && unit.kind !== 'reference'
      && !IMMUTABLE_KINDS.has(unit.kind)
      && Boolean(unit.sourceText?.trim())
    ))
    .map((unit) => {
      const candidates = buildSourceSentenceCandidates(unit.id, unit.sourceText!);
      const titleTerms = unit.kind === 'title'
        ? [
            unit.sourceText!.match(/^\s*([A-Z][A-Za-z0-9-]{2,})\s*:/)?.[1],
            ...(unit.sourceText!.match(/\b[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]{2,})*\b/g) ?? []),
          ].filter((term): term is string => Boolean(term))
        : [];
      const titleFootnoteMarkers = unit.kind === 'title'
        ? unit.sourceText!.match(/[∗*†‡]+(?=\s*$)/gu) ?? []
        : [];
      return {
        blockId: unit.id,
        kind: translationKind(unit.kind),
        source: unit.sourceText!,
        alignmentMode: candidates.mode,
        sourceSentences: candidates.sentences,
        protectedTokens: [...new Set([
          ...extractProtectedTokens(unit.sourceText!),
          ...titleTerms,
          ...titleFootnoteMarkers,
        ])],
      };
    });
}

export class DeepSeekProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepSeekProtocolError';
  }
}

export function parseDeepSeekTranslationJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
    throw new DeepSeekProtocolError('DeepSeek 返回的 JSON 无法解析');
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeepSeekProtocolError(`DeepSeek JSON ${path} 必须为对象`);
  }
  return value as Record<string, unknown>;
}

function objectArray(value: unknown, path: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  throw new DeepSeekProtocolError(`DeepSeek JSON ${path} 必须为数组或对象`);
}

function stringArray(value: unknown, path: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  throw new DeepSeekProtocolError(`DeepSeek JSON ${path} 必须为数组或字符串`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new DeepSeekProtocolError(`DeepSeek JSON 缺少 ${field}`);
  return value;
}

export function normalizeDeepSeekTranslationResponse(input: unknown): TranslationResponse {
  if (!input || typeof input !== 'object') throw new DeepSeekProtocolError('DeepSeek 未返回 JSON 对象');
  const root = input as Record<string, unknown>;
  return {
    blocks: objectArray(root.blocks, 'blocks').map((raw, blockIndex) => {
      const blockPath = `blocks[${blockIndex}]`;
      const block = object(raw, blockPath);
      const groups = block.alignmentGroups ?? block.alignment_groups;
      const terms = block.newTerms ?? block.new_terms ?? [];
      return {
        blockId: text(block.blockId ?? block.block_id, `${blockPath}.block_id`),
        translation: text(block.translation, `${blockPath}.translation`),
        alignmentGroups: objectArray(groups, `${blockPath}.alignment_groups`).map((rawGroup, groupIndex) => {
          const groupPath = `${blockPath}.alignment_groups[${groupIndex}]`;
          const group = object(rawGroup, groupPath);
          return {
            sourceSentenceIds: stringArray(
              group.sourceSentenceIds ?? group.source_sentence_ids,
              `${groupPath}.source_sentence_ids`,
            ).map((id, index) => text(id, `${groupPath}.source_sentence_ids[${index}]`)),
            targetSegments: stringArray(
              group.targetSegments ?? group.target_segments,
              `${groupPath}.target_segments`,
            ).map((segment, index) => text(segment, `${groupPath}.target_segments[${index}]`)),
          };
        }),
        newTerms: objectArray(terms, `${blockPath}.new_terms`).map((rawTerm, termIndex) => {
          const termPath = `${blockPath}.new_terms[${termIndex}]`;
          const term = object(rawTerm, termPath);
          return {
            source: text(term.source, `${termPath}.source`),
            target: text(term.target, `${termPath}.target`),
            abbreviation: typeof term.abbreviation === 'string' ? term.abbreviation : undefined,
          };
        }),
        warnings: stringArray(block.warnings ?? [], `${blockPath}.warnings`)
          .map((warning, index) => text(warning, `${blockPath}.warnings[${index}]`)),
      };
    }),
  };
}

export interface PreparedImmutableStructure {
  regions: LayoutRegion[];
  units: SemanticUnit[];
  assetRegions: DetectedAssetRegion[];
}

export interface PrepareImmutableOptions {
  /** Vision regions after protocol, confidence, coordinate and geometry reconciliation. */
  verifiedAssetRegions?: readonly DetectedAssetRegion[];
  /** Exact math-font runs retained before text-block grouping scatters scripts. */
  fontFormulaRegions?: readonly FontFormulaRegion[];
  /** Vision page layout is authoritative when the parser is confused by formula/figure text fragments. */
  pageLayouts?: ReadonlyMap<number, 'single' | 'double' | 'mixed'>;
}

export interface ParsedHeadingPart {
  number?: string;
  level: 1 | 2 | 3;
  text: string;
}

/**
 * Extract structural heading numbers before translation. A parser block may
 * contain two adjacent headings (for example `2 Background 2.1 Motivation`).
 * Only heading units are passed here, so a later numeric phrase cannot split
 * ordinary body prose.
 */
export function parseHeadingParts(source: string): ParsedHeadingPart[] {
  const normalized = source.replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  if (!normalized) return [];
  const matches: Array<{
    start: number;
    contentStart: number;
    number: string;
    level: 1 | 2 | 3;
  }> = [];
  // The alternatives must be disjoint. In particular, I/V/X are plausible
  // single-token Roman section numbers, while C/D/L/M are overwhelmingly used
  // as alphabetic subsection labels in papers (a paper is not expected to
  // reach section 50, 100, 500, or 1000). Keeping the token kind in the match
  // avoids inferring hierarchy from whether the heading text happens to be all
  // uppercase, which misclassified title-case headings such as `V. Related Work`.
  const pattern = /(^|\s)(?:(\d{1,2}(?:\.\d{1,2}){0,2})\.?|((?:[IVXLCDM]{2,8}|[IVX]))\.?|([A-Z])\.)(?:\s+)(?=[A-Za-z\u00c0-\u024f\u3400-\u9fff])/g;
  for (const match of normalized.matchAll(pattern)) {
    const prefix = match[1] ?? '';
    const decimalNumber = match[2];
    const romanNumber = match[3];
    const alphabeticNumber = match[4];
    const number = decimalNumber ?? romanNumber ?? alphabeticNumber!;
    const start = (match.index ?? 0) + prefix.length;
    const numericLevel = decimalNumber ? decimalNumber.split('.').length : 1;
    matches.push({
      start,
      contentStart: (match.index ?? 0) + match[0].length,
      number,
      level: alphabeticNumber ? 2 : Math.min(3, numericLevel) as 1 | 2 | 3,
    });
  }
  if (!matches.length || matches[0]!.start > 0) return [{ level: 1, text: normalized }];
  return matches.flatMap((match, index) => {
    const text = normalized.slice(match.contentStart, matches[index + 1]?.start ?? normalized.length).trim();
    if (!text) return [];
    return [{ number: match.number, level: match.level, text }];
  });
}

type FrontMatterLineRole = 'author' | 'affiliation';

function frontMatterLineRole(source: string): FrontMatterLineRole | undefined {
  const text = source.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (/@|\b(?:university|institute|institution|laborator(?:y|ies)|department|school|college|academy|faculty|group|cent(?:er|re))\b/i.test(text)) {
    return 'affiliation';
  }
  const names = text.match(/\b[A-Z][A-Za-z'’-]{1,}(?:\s+[A-Z][A-Za-z'’-]{1,})+\b/g) ?? [];
  if (names.length >= 2 || (names.length >= 1 && /(?:,|\band\b|&)/i.test(text))) return 'author';
  return undefined;
}

function looksLikeTitleContinuationLine(source: string): boolean {
  const text = source.replace(/\s+/g, ' ').trim();
  const words = text.match(/[A-Za-z][A-Za-z-]*/g) ?? [];
  return text.length >= 5
    && text.length <= 100
    && words.length >= 2
    && words.length <= 14
    && !/@|\b(?:university|institute|department|school|college|group|cent(?:er|re))\b/i.test(text)
    && !/[.!?;:]$/.test(text);
}

function splitFirstPageFrontMatter(
  doc: Doc,
  inputUnits: SemanticUnit[],
  regions: LayoutRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): SemanticUnit[] {
  let units = [...inputUnits];
  const title = units.find((unit) => unit.kind === 'title' && Boolean(unit.sourceText));
  const titleBlock = title ? blocks.get(title.sourceBlockId ?? title.id) : undefined;
  if (!title?.sourceText || !titleBlock || titleBlock.pageIndex !== 0) return units;
  const titleBottom = titleBlock.rect.y + titleBlock.rect.h;
  const pageWidth = doc.pages[0]?.width ?? doc.meta.paperWidth;
  const pageHeight = doc.pages[0]?.height ?? doc.meta.paperHeight;
  const firstHeadingTop = units
    .filter((unit) => unit.kind === 'heading')
    .map((unit) => blocks.get(unit.sourceBlockId ?? unit.id))
    .filter((block): block is Doc['blocks'][number] => Boolean(block) && block!.pageIndex === 0)
    .map((block) => block.rect.y)
    .sort((left, right) => left - right)[0] ?? doc.meta.paperHeight * 0.55;

  const emptiedTitleContinuationIds = new Set<string>();
  for (const unit of units) {
    if (unit.kind !== 'paragraph' || !unit.sourceText) continue;
    const block = blocks.get(unit.sourceBlockId ?? unit.id);
    if (!block || block.pageIndex !== 0 || block.rect.y < titleBottom - 2 || block.rect.y > titleBottom + 36) continue;
    const center = block.rect.x + block.rect.w / 2;
    if (block.rect.w > pageWidth * 0.72 || Math.abs(center - pageWidth / 2) > pageWidth * 0.12) continue;
    const lines = unit.sourceText.split(/\r?\n/);
    const continuation: string[] = [];
    while (lines.length
      && !frontMatterLineRole(lines[0]!)
      && looksLikeTitleContinuationLine(lines[0]!)) continuation.push(lines.shift()!);
    if (!continuation.length) continue;
    title.sourceText = `${title.sourceText.trim()}\n${continuation.join('\n')}`;
    title.protectedTokens = extractProtectedTokens(title.sourceText);
    unit.sourceText = lines.join('\n').trim();
    unit.protectedTokens = extractProtectedTokens(unit.sourceText);
    if (!unit.sourceText) emptiedTitleContinuationIds.add(unit.id);
  }

  const replacements = new Map<string, SemanticUnit[]>(
    [...emptiedTitleContinuationIds].map((id) => [id, []]),
  );
  for (const unit of units) {
    if (!unit.sourceText) continue;
    if (!['paragraph', 'author', 'affiliation'].includes(unit.kind)) continue;
    const block = blocks.get(unit.sourceBlockId ?? unit.id);
    if (!block || block.pageIndex !== 0 || block.rect.y < titleBottom - 2 || block.rect.y >= firstHeadingTop) continue;
    const center = block.rect.x + block.rect.w / 2;
    if (block.rect.y > pageHeight * 0.38
      || block.rect.w > pageWidth * 0.76
      || Math.abs(center - pageWidth / 2) > pageWidth * 0.16) continue;
    const lines = unit.sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) {
      replacements.set(unit.id, []);
      continue;
    }
    const groups: Array<{ role: FrontMatterLineRole; lines: string[] }> = [];
    for (const line of lines) {
      const role = frontMatterLineRole(line);
      if (!role) continue;
      const previous = groups.at(-1);
      if (previous?.role === role) previous.lines.push(line);
      else groups.push({ role, lines: [line] });
    }
    if (!groups.length || groups.flatMap((group) => group.lines).length !== lines.length) continue;
    if (groups.length === 1) {
      unit.kind = groups[0]!.role;
      unit.parentId = undefined;
      unit.sourceText = groups[0]!.lines.join('\n');
      unit.protectedTokens = extractProtectedTokens(unit.sourceText);
      continue;
    }
    replacements.set(unit.id, groups.map((group, index): SemanticUnit => ({
      ...unit,
      id: `${unit.id}-${group.role}-${index + 1}`,
      parentId: undefined,
      kind: group.role,
      sourceText: group.lines.join('\n'),
      protectedTokens: extractProtectedTokens(group.lines.join('\n')),
      sourceBlockId: unit.sourceBlockId ?? unit.id,
      order: unit.order + index / 1_000,
    })));
  }
  if (replacements.size) {
    units = units.flatMap((unit) => replacements.get(unit.id) ?? [unit]);
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.flatMap((unitId) => (
        replacements.get(unitId)?.map((unit) => unit.id) ?? [unitId]
      ));
    }
  }

  const titleRegion = regions.find((region) => region.id === title.layoutRegionId);
  if (!titleRegion) return units;
  const frontMatter = units.filter((unit) => {
    if (unit.kind !== 'author' && unit.kind !== 'affiliation') return false;
    const block = blocks.get(unit.sourceBlockId ?? unit.id);
    return Boolean(block && block.pageIndex === 0 && block.rect.y < firstHeadingTop);
  });
  const frontMatterIds = new Set(frontMatter.map((unit) => unit.id));
  for (const region of regions) {
    region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !frontMatterIds.has(unitId));
  }
  const markerNumber = (unit: SemanticUnit): number => Number(unit.sourceText?.match(/^\s*(\d+)/)?.[1] ?? 999);
  const ordered = [
    ...frontMatter.filter((unit) => unit.kind === 'author').sort((left, right) => left.order - right.order),
    ...frontMatter.filter((unit) => unit.kind === 'affiliation').sort((left, right) => (
      markerNumber(left) - markerNumber(right) || left.order - right.order
    )),
  ];
  ordered.forEach((unit) => { unit.layoutRegionId = titleRegion.id; });
  const titleIndex = Math.max(0, titleRegion.orderedUnitIds.indexOf(title.id));
  titleRegion.orderedUnitIds.splice(titleIndex + 1, 0, ...ordered.map((unit) => unit.id));
  return units;
}

function normalizeFirstPageFrontMatter(
  doc: Doc,
  units: SemanticUnit[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): void {
  const pageWidth = doc.pages[0]?.width ?? doc.meta.paperWidth;
  const title = units.find((unit) => unit.kind === 'title');
  const titleBlock = title ? blocks.get(title.sourceBlockId ?? title.id) : undefined;
  const firstBodyTop = units
    .filter((unit) => ['abstract', 'keywords', 'heading'].includes(unit.kind))
    .map((unit) => blocks.get(unit.sourceBlockId ?? unit.id))
    .filter((block): block is Doc['blocks'][number] => Boolean(block) && block!.pageIndex === 0)
    .map((block) => block.rect.y)
    .sort((left, right) => left - right)[0] ?? doc.meta.paperHeight * 0.38;
  for (const unit of units) {
    if (unit.kind !== 'paragraph' || !unit.sourceText) continue;
    const block = blocks.get(unit.sourceBlockId ?? unit.id);
    if (!block || block.pageIndex !== 0) continue;
    if (titleBlock && block.rect.y < titleBlock.rect.y + titleBlock.rect.h - 2) continue;
    if (block.rect.y >= firstBodyTop || block.rect.y > doc.meta.paperHeight * 0.34) continue;
    const center = block.rect.x + block.rect.w / 2;
    if (Math.abs(center - pageWidth / 2) > pageWidth * 0.14) continue;
    const text = unit.sourceText.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 320) continue;
    const affiliation = /\b(?:university|institute|institution|laborator(?:y|ies)|department|school|college|academy|faculty|cent(?:er|re)|email|e-mail)\b|@/i.test(text);
    const nameTokens = text.match(/\b[A-Z][A-Za-z'’-]{1,}(?:\s+[A-Z][A-Za-z'’-]{1,})+\b/g) ?? [];
    const author = nameTokens.length >= 2 || (nameTokens.length >= 1 && /(?:,|\band\b|&)/i.test(text));
    if (affiliation) unit.kind = 'affiliation';
    else if (author) unit.kind = 'author';
    else continue;
    unit.parentId = undefined;
  }
}

function normalizeScopedFrontMatterRoles(
  units: SemanticUnit[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): void {
  const firstHeadingTop = units
    .filter((unit) => unit.kind === 'heading')
    .map((unit) => blocks.get(unit.sourceBlockId ?? unit.id))
    .filter((block): block is Doc['blocks'][number] => Boolean(block) && block!.pageIndex === 0)
    .map((block) => block.rect.y)
    .sort((left, right) => left - right)[0] ?? Number.POSITIVE_INFINITY;
  for (const unit of units) {
    if (unit.kind !== 'author' && unit.kind !== 'affiliation') continue;
    const block = blocks.get(unit.sourceBlockId ?? unit.id);
    if (!block || block.pageIndex !== 0 || block.rect.y >= firstHeadingTop) {
      unit.kind = 'paragraph';
      if (unit.parentId === unit.id) unit.parentId = undefined;
    }
  }
}

function normalizeDocumentTitleRoles(
  units: SemanticUnit[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): void {
  const primaryTitle = units
    .filter((unit) => unit.kind === 'title')
    .map((unit) => ({ unit, block: blocks.get(unit.sourceBlockId ?? unit.id) }))
    .filter((candidate): candidate is { unit: SemanticUnit; block: Doc['blocks'][number] } => (
      Boolean(candidate.block) && candidate.block!.pageIndex === 0
    ))
    .sort((left, right) => left.block.rect.y - right.block.rect.y || left.unit.order - right.unit.order)[0]?.unit;
  for (const unit of units) {
    if (unit.kind !== 'title' || unit.id === primaryTitle?.id) continue;
    unit.kind = 'heading';
    unit.parentId = undefined;
  }
}

function mergeDanglingUrlFragments(
  doc: Doc,
  inputUnits: SemanticUnit[],
  regions: LayoutRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): SemanticUnit[] {
  const removedIds = new Set<string>();
  const urlPath = /^[A-Za-z0-9._~%+-]+(?:\/[A-Za-z0-9._~%+-]+)+(?:\s*[.,;:])?$/;
  const pageOffset = (pageIndex: number): number => doc.pages
    .slice(0, pageIndex)
    .reduce((total, page) => total + page.height, 0);
  for (const fragment of inputUnits) {
    if (!fragment.sourceText || removedIds.has(fragment.id)
      || !['paragraph', 'list-item'].includes(fragment.kind)) continue;
    const fragmentText = fragment.sourceText.replace(/\s+/g, ' ').trim();
    if (fragmentText.length > 100 || !urlPath.test(fragmentText)) continue;
    const fragmentBlock = blocks.get(fragment.sourceBlockId ?? fragment.id);
    if (!fragmentBlock) continue;
    const fragmentTop = pageOffset(fragmentBlock.pageIndex) + fragmentBlock.rect.y;
    const owner = inputUnits
      .filter((unit) => unit.id !== fragment.id && !removedIds.has(unit.id) && Boolean(unit.sourceText))
      .map((unit) => ({ unit, block: blocks.get(unit.sourceBlockId ?? unit.id) }))
      .filter((candidate): candidate is { unit: SemanticUnit; block: Doc['blocks'][number] } => {
        if (!candidate.block || !/https?:\/\/\S+\/\s*$/i.test(candidate.unit.sourceText!)) return false;
        if (fragmentBlock.pageIndex - candidate.block.pageIndex < 0
          || fragmentBlock.pageIndex - candidate.block.pageIndex > 1) return false;
        const horizontalOverlap = Math.max(0, Math.min(
          candidate.block.rect.x + candidate.block.rect.w,
          fragmentBlock.rect.x + fragmentBlock.rect.w,
        ) - Math.max(candidate.block.rect.x, fragmentBlock.rect.x));
        return horizontalOverlap >= Math.min(candidate.block.rect.w, fragmentBlock.rect.w) * 0.5;
      })
      .map((candidate) => ({
        ...candidate,
        gap: fragmentTop - (
          pageOffset(candidate.block.pageIndex) + candidate.block.rect.y + candidate.block.rect.h
        ),
      }))
      .filter((candidate) => candidate.gap >= -2 && candidate.gap <= 28)
      .sort((left, right) => left.gap - right.gap)[0];
    if (!owner) continue;
    const cleanedFragment = fragmentText.replace(/\s+([.,;:])$/, '$1');
    owner.unit.sourceText = `${owner.unit.sourceText!.trimEnd()}${cleanedFragment}`;
    owner.unit.protectedTokens = extractProtectedTokens(owner.unit.sourceText);
    removedIds.add(fragment.id);
  }
  if (!removedIds.size) return inputUnits;
  for (const region of regions) {
    region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !removedIds.has(unitId));
  }
  return inputUnits.filter((unit) => !removedIds.has(unit.id));
}

function normalizeAbstractAndKeywordContinuations(
  inputUnits: SemanticUnit[],
  regions: LayoutRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): SemanticUnit[] {
  const removedIds = new Set<string>();
  for (const unit of inputUnits) {
    const block = blocks.get(unit.sourceBlockId ?? unit.id);
    if (!block || block.pageIndex !== 0 || !unit.sourceText) continue;
    if (unit.kind === 'paragraph' && /^\s*(?:abstract|摘要)\s*[.：:—-]/i.test(unit.sourceText)) {
      unit.kind = 'abstract';
    }
    if (unit.kind === 'abstract') {
      unit.sourceText = unit.sourceText
        .replace(/^\s*(?:abstract|摘要)\s*(?:[.：:—-]\s*)?/i, '')
        .trim();
      unit.protectedTokens = extractProtectedTokens(unit.sourceText);
      if (!unit.sourceText) removedIds.add(unit.id);
    } else if (unit.kind === 'keywords') {
      unit.sourceText = unit.sourceText
        .replace(/^\s*(?:index\s+terms|key\s*words?|关键词)\s*(?:[.：:—-]\s*)?/i, '')
        .trim();
      unit.protectedTokens = extractProtectedTokens(unit.sourceText);
      if (!unit.sourceText) removedIds.add(unit.id);
    }
  }
  for (const keywords of inputUnits.filter((unit) => unit.kind === 'keywords' && Boolean(unit.sourceText))) {
    const keywordBlock = blocks.get(keywords.sourceBlockId ?? keywords.id);
    if (!keywordBlock) continue;
    const continuation = inputUnits
      .filter((unit) => unit.kind === 'paragraph' && !removedIds.has(unit.id) && Boolean(unit.sourceText))
      .map((unit) => ({ unit, block: blocks.get(unit.sourceBlockId ?? unit.id) }))
      .filter((candidate): candidate is { unit: SemanticUnit; block: Doc['blocks'][number] } => (
        Boolean(candidate.block)
        && candidate.block!.pageIndex === keywordBlock.pageIndex
        && candidate.block!.rect.y >= keywordBlock.rect.y + keywordBlock.rect.h - 2
        && candidate.block!.rect.y - (keywordBlock.rect.y + keywordBlock.rect.h) <= 22
        && /^[\s·•]/u.test(candidate.unit.sourceText!)
      ))
      .sort((left, right) => left.block.rect.y - right.block.rect.y)[0];
    if (!continuation) continue;
    keywords.sourceText = `${keywords.sourceText!.trim()} ${continuation.unit.sourceText!.trim()}`;
    keywords.protectedTokens = extractProtectedTokens(keywords.sourceText);
    removedIds.add(continuation.unit.id);
  }
  if (!removedIds.size) return inputUnits;
  for (const region of regions) {
    region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !removedIds.has(unitId));
  }
  return inputUnits.filter((unit) => !removedIds.has(unit.id));
}

function normalizeHeadingHierarchy(
  units: SemanticUnit[],
  regions: LayoutRegion[],
): SemanticUnit[] {
  const normalized = [...units];
  for (const unit of [...normalized]) {
    if (unit.kind !== 'heading' || !unit.sourceText) continue;
    const parts = parseHeadingParts(unit.sourceText);
    if (!parts.length) continue;
    const children = parts.map((part, index): SemanticUnit => ({
      ...unit,
      id: index === 0 ? unit.id : `${unit.id}-heading-${index + 1}`,
      parentId: index === 0 ? unit.parentId : unit.id,
      sourceBlockId: unit.sourceBlockId ?? unit.id,
      sourceText: part.text,
      headingNumber: part.number,
      headingLevel: part.level,
      protectedTokens: extractProtectedTokens(part.text),
      order: unit.order + index / 1_000,
    }));
    const unitIndex = normalized.findIndex((candidate) => candidate.id === unit.id);
    normalized.splice(unitIndex, 1, ...children);
    const region = regions.find((candidate) => candidate.id === unit.layoutRegionId);
    const regionIndex = region?.orderedUnitIds.indexOf(unit.id) ?? -1;
    if (region && regionIndex >= 0) {
      region.orderedUnitIds.splice(regionIndex, 1, ...children.map((child) => child.id));
    }
  }
  return normalized;
}

function mergeFirstPageTitleContinuations(
  doc: Doc,
  units: SemanticUnit[],
  regions: LayoutRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): SemanticUnit[] {
  const title = units.find((unit) => unit.kind === 'title' && Boolean(unit.sourceText));
  const titleBlock = title ? blocks.get(title.sourceBlockId ?? title.id) : undefined;
  if (!title?.sourceText || !titleBlock || titleBlock.pageIndex !== 0) return units;
  const titleBottom = titleBlock.rect.y + titleBlock.rect.h;
  const pageWidth = doc.pages[0]?.width ?? doc.meta.paperWidth;
  const continuations = units.filter((unit) => {
    if (unit.id === title.id || unit.kind !== 'paragraph' || !unit.sourceText || unit.parentId) return false;
    const block = blocks.get(unit.sourceBlockId ?? unit.id);
    if (!block || block.pageIndex !== 0) return false;
    const gap = block.rect.y - titleBottom;
    if (gap < -1 || gap > 20 || block.rect.h > titleBlock.rect.h) return false;
    const centerDistance = Math.abs(
      block.rect.x + block.rect.w / 2 - (titleBlock.rect.x + titleBlock.rect.w / 2),
    );
    if (centerDistance > pageWidth * 0.08) return false;
    const text = unit.sourceText.replace(/\s+/g, ' ').trim();
    const words = text.match(/[A-Za-z]{2,}/g) ?? [];
    return text.length >= 5
      && text.length <= 120
      && words.length >= 2
      && words.length <= 14
      && !/[.!?;:]$/.test(text)
      && !/@|\b(?:abstract|keywords?)\b/i.test(text);
  }).sort((left, right) => (
    blocks.get(left.sourceBlockId ?? left.id)!.rect.y
    - blocks.get(right.sourceBlockId ?? right.id)!.rect.y
  ));
  if (!continuations.length) return units;
  title.sourceText = [title.sourceText.trim(), ...continuations.map((unit) => unit.sourceText!.trim())].join('\n');
  title.protectedTokens = extractProtectedTokens(title.sourceText);
  const continuationIds = new Set(continuations.map((unit) => unit.id));
  for (const region of regions) {
    region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !continuationIds.has(unitId));
  }
  return units.filter((unit) => !continuationIds.has(unit.id));
}

function visualCharacterRowText(characters: readonly CharacterRect[]): string {
  const ordered = [...characters]
    .filter((character) => character.ch.trim().length > 0)
    .sort((left, right) => left.rect.x - right.rect.x || left.sourceIndex - right.sourceIndex);
  const seen = new Set<string>();
  let result = '';
  let previous: CharacterRect | undefined;
  for (const character of ordered) {
    const key = [
      Math.round(character.rect.x * 10), Math.round(character.rect.y * 10),
      Math.round(character.rect.w * 10), character.ch,
    ].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    if (previous) {
      const gap = character.rect.x - (previous.rect.x + previous.rect.w);
      if (gap > Math.max(1.5, Math.min(previous.rect.h, character.rect.h) * 0.18)) result += ' ';
    }
    result += character.ch;
    previous = character;
  }
  return result.replace(/\s+/g, ' ').trim();
}

/**
 * Small-caps IEEE headings are occasionally emitted as several overlapping
 * text blocks on the same visual baseline. Reconstruct that baseline from
 * character geometry and remove only those heading glyphs from the following
 * prose block, leaving its body lines translatable.
 */
function repairSplitHeadingRows(
  doc: Doc,
  inputUnits: SemanticUnit[],
  regions: LayoutRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): SemanticUnit[] {
  let units = inputUnits;
  const emptied = new Set<string>();
  for (const heading of [...units].filter((unit) => unit.kind === 'heading' && Boolean(unit.sourceText))) {
    const headingBlock = blocks.get(heading.sourceBlockId ?? heading.id);
    if (!headingBlock || !/^\s*(?:\d{1,2}(?:\.\d+)*|[IVXLCDM]+)\./.test(heading.sourceText!)) continue;
    const headingCharacters = (headingBlock.characterRects ?? [])
      .filter((character) => character.pageIndex === headingBlock.pageIndex && character.ch.trim());
    if (!headingCharacters.length) continue;
    const rowTop = Math.min(...headingCharacters.map((character) => character.rect.y));
    const rowBottom = Math.max(...headingCharacters.map((character) => character.rect.y + character.rect.h));
    const rowCenter = (rowTop + rowBottom) / 2;
    const pageWidth = doc.pages[headingBlock.pageIndex]?.width ?? doc.meta.paperWidth;
    const candidates = [...blocks.values()].filter((candidate) => (
      candidate.pageIndex === headingBlock.pageIndex
      && ['section', 'paragraph'].includes(candidate.type)
      && sameVisualColumn(candidate, headingBlock, pageWidth)
      && (candidate.characterRects ?? []).some((character) => {
        const center = character.rect.y + character.rect.h / 2;
        return character.pageIndex === headingBlock.pageIndex && Math.abs(center - rowCenter) <= 3.5;
      })
    ));
    const rowCharacters = candidates.flatMap((candidate) => (
      (candidate.characterRects ?? []).filter((character) => {
        const center = character.rect.y + character.rect.h / 2;
        return character.pageIndex === headingBlock.pageIndex && Math.abs(center - rowCenter) <= 3.5;
      })
    ));
    const reconstructed = visualCharacterRowText(rowCharacters);
    const headingWords = reconstructed.match(/[A-Za-z\u3400-\u9fff]{2,}/g) ?? [];
    if (!/^\s*(?:\d{1,2}(?:\.\d+)*|[IVXLCDM]+)\./.test(reconstructed)
      || headingWords.length < 2 || reconstructed.length > 120) continue;
    heading.sourceText = reconstructed;
    heading.protectedTokens = extractProtectedTokens(reconstructed);

    for (const candidate of candidates) {
      if (candidate.id === headingBlock.id || !candidate.text || !candidate.characterRects?.length) continue;
      const unit = units.find((item) => (item.sourceBlockId ?? item.id) === candidate.id);
      if (!unit?.sourceText || unit.sourceText !== candidate.text) continue;
      const masked = new Uint8Array(candidate.text.length);
      for (const character of candidate.characterRects) {
        const center = character.rect.y + character.rect.h / 2;
        if (character.pageIndex !== headingBlock.pageIndex || Math.abs(center - rowCenter) > 3.5) continue;
        for (let index = Math.max(0, character.sourceIndex);
          index < Math.min(candidate.text.length, character.sourceIndex + character.ch.length);
          index += 1) masked[index] = 1;
      }
      const cleaned = [...candidate.text]
        .map((character, index) => masked[index] ? ' ' : character)
        .join('')
        .split(/\r?\n/)
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
      if (!cleaned) emptied.add(unit.id);
      else {
        unit.sourceText = cleaned;
        unit.protectedTokens = extractProtectedTokens(cleaned);
      }
    }
  }
  if (!emptied.size) return units;
  for (const region of regions) {
    region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !emptied.has(unitId));
  }
  units = units.filter((unit) => !emptied.has(unit.id));
  return units;
}

function repairHeadingRegionOrder(
  doc: Doc,
  units: SemanticUnit[],
  regions: LayoutRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): void {
  for (const heading of units.filter((unit) => unit.kind === 'heading')) {
    const headingBlock = blocks.get(heading.sourceBlockId ?? heading.id);
    if (!headingBlock) continue;
    const pageWidth = doc.pages[headingBlock.pageIndex]?.width ?? doc.meta.paperWidth;
    const headingBottom = headingBlock.rect.y + headingBlock.rect.h;
    const following = units
      .filter((unit) => (
        unit.id !== heading.id
        && !['title', 'author', 'page-furniture'].includes(unit.kind)
        && Boolean(unit.layoutRegionId)
      ))
      .map((unit) => ({ unit, block: blocks.get(unit.sourceBlockId ?? unit.id) }))
      .filter((candidate): candidate is { unit: SemanticUnit; block: Doc['blocks'][number] } => (
        Boolean(candidate.block)
        && candidate.block!.pageIndex === headingBlock.pageIndex
        && candidate.block!.rect.y >= headingBottom - 2
        // PDF parsers commonly mark a one-column prose block as `span` while
        // marking its short heading as `column`, even though their left edges
        // and physical reading lane are identical.  Requiring equal widthMode
        // in that transition leaves the heading in a later layout region.
        && (
          sameVisualColumn(candidate.block!, headingBlock, pageWidth)
          || Math.abs(candidate.block!.rect.x - headingBlock.rect.x) <= pageWidth * 0.12
        )
      ))
      .sort((left, right) => (
        left.block.rect.y - right.block.rect.y
        || left.block.rect.x - right.block.rect.x
        || left.unit.order - right.unit.order
      ))[0];
    if (!following || following.block.rect.y - headingBottom > 90) continue;
    const targetRegion = regions.find((region) => region.id === following.unit.layoutRegionId);
    if (!targetRegion) continue;
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => unitId !== heading.id);
    }
    const targetIndex = targetRegion.orderedUnitIds.indexOf(following.unit.id);
    targetRegion.orderedUnitIds.splice(targetIndex < 0 ? 0 : targetIndex, 0, heading.id);
    heading.layoutRegionId = targetRegion.id;
    heading.order = Math.min(heading.order, following.unit.order - 0.01);
  }
}

function intersectionArea(left: { x: number; y: number; w: number; h: number }, right: { x: number; y: number; w: number; h: number }): number {
  return Math.max(0, Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x))
    * Math.max(0, Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y));
}

function assetCompositesSourcePoint(asset: DetectedAssetRegion, x: number, y: number): boolean {
  const inside = asset.preserveRects?.length
    ? asset.preserveRects.some((preserve) => (
      x >= preserve.x && x <= preserve.x + preserve.w
      && y >= preserve.y && y <= preserve.y + preserve.h
    ))
    : x >= asset.rect.x && x <= asset.rect.x + asset.rect.w
      && y >= asset.rect.y && y <= asset.rect.y + asset.rect.h;
  return inside && !(asset.eraseRects ?? []).some((erase) => (
    x >= erase.x && x <= erase.x + erase.w
    && y >= erase.y && y <= erase.y + erase.h
  ));
}

function assetCompositesSourceCharacter(
  asset: DetectedAssetRegion,
  block: Doc['blocks'][number],
  character: CharacterRect,
): boolean {
  const exactRanges = (asset.sourceCharacterRanges ?? [])
    .filter((range) => range.blockId === block.id);
  if (exactRanges.length) {
    return exactRanges.some((range) => (
      character.sourceIndex >= range.start && character.sourceIndex < range.end
    ));
  }
  const centerX = character.rect.x + character.rect.w / 2;
  const centerY = character.rect.y + character.rect.h / 2;
  return assetCompositesSourcePoint(asset, centerX, centerY);
}

function materiallyCovered(block: Doc['blocks'][number], asset: DetectedAssetRegion): boolean {
  if (block.characterRects?.length) {
    const visible = block.characterRects.filter((character) => character.ch.trim().length > 0);
    const sourceGlyphCount = (block.text ?? '').replace(/\s+/g, '').length;
    const representedGlyphCount = visible.reduce(
      (total, character) => total + character.ch.replace(/\s+/g, '').length,
      0,
    );
    // Some PDFs expose geometry for the math font but omit the ordinary words
    // carried by the same text item. A high coverage ratio over that partial
    // character list does not prove that the whole semantic block is an asset.
    // Fall back to the conservative rectangle ratio unless the character map
    // represents a meaningful share of the source string.
    const characterMapComplete = sourceGlyphCount === 0
      || representedGlyphCount / sourceGlyphCount >= 0.5;
    if (visible.length && characterMapComplete) {
      const covered = visible.filter((character) => {
        if (character.pageIndex !== asset.pageIndex) return false;
        return assetCompositesSourceCharacter(asset, block, character);
      }).length;
      return covered / visible.length >= 0.8;
    }
  }
  if (block.pageIndex !== asset.pageIndex) return false;
  return intersectionArea(block.rect, asset.rect) / Math.max(1, block.rect.w * block.rect.h) >= 0.5;
}

function unionRects(rects: readonly Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function physicalRectOnPage(block: Doc['blocks'][number], pageIndex: number): Rect | undefined {
  const characters = (block.characterRects ?? []).filter((character) => (
    character.pageIndex === pageIndex && character.ch.trim().length > 0
  ));
  const characterRect = unionRects(characters.map((character) => character.rect));
  if (characterRect) return characterRect;
  const fragments = (block.fragments ?? []).filter((fragment) => fragment.pageIndex === pageIndex);
  const fragmentRect = unionRects(fragments.map((fragment) => fragment.rect));
  if (fragmentRect) return fragmentRect;
  return block.pageIndex === pageIndex ? block.rect : undefined;
}

function physicalPages(block: Doc['blocks'][number]): number[] {
  return [...new Set([
    block.pageIndex,
    ...(block.fragments ?? []).map((fragment) => fragment.pageIndex),
    ...(block.characterRects ?? []).map((character) => character.pageIndex),
  ])];
}

function proseHeavyFormulaRegion(doc: Doc, asset: DetectedAssetRegion): boolean {
  if (asset.kind !== 'formula') return false;
  // A narrow box cutting through multiple ordinary text lines is a prose
  // fragment, even when it contains too few complete words for the test below.
  if (asset.geometrySource !== 'font-runs' && doc.blocks.some((block) => {
    if (block.type !== 'paragraph' || block.pageIndex !== asset.pageIndex
      || asset.rect.w >= block.rect.w * 0.25
      || (block.text?.match(/[A-Za-z]{3,}/g)?.length ?? 0) < 5) return false;
    const characters = block.characterRects ?? [];
    const inside = characters.filter(({ ch, rect }) => /[A-Za-z]/.test(ch)
      && rect.x + rect.w / 2 >= asset.rect.x
      && rect.x + rect.w / 2 <= asset.rect.x + asset.rect.w
      && rect.y + rect.h / 2 >= asset.rect.y
      && rect.y + rect.h / 2 <= asset.rect.y + asset.rect.h);
    const cutLines: number[] = [];
    for (const character of inside) {
      const { rect } = character;
      if (cutLines.some((y) => Math.abs(y - rect.y) < rect.h / 2)) continue;
      const sameLine = characters.filter((other) => /[A-Za-z]/.test(other.ch)
        && Math.abs(other.rect.y - rect.y) < rect.h / 2);
      if (sameLine.some((other) => other.rect.x + other.rect.w < asset.rect.x)
        && sameLine.some((other) => other.rect.x > asset.rect.x + asset.rect.w)) {
        cutLines.push(rect.y);
      }
    }
    return cutLines.length >= 2;
  })) return true;
  const text = doc.blocks
    .flatMap((block) => (block.characterRects ?? [])
      .filter((character) => {
        if (character.pageIndex !== asset.pageIndex) return false;
        const centerX = character.rect.x + character.rect.w / 2;
        const centerY = character.rect.y + character.rect.h / 2;
        return centerX >= asset.rect.x && centerX <= asset.rect.x + asset.rect.w
          && centerY >= asset.rect.y && centerY <= asset.rect.y + asset.rect.h;
      })
      .map((character) => ({
        blockOrder: block.order,
        sourceIndex: character.sourceIndex,
        ch: character.ch,
      })))
    .sort((left, right) => left.blockOrder - right.blockOrder || left.sourceIndex - right.sourceIndex)
    .map((character) => character.ch)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const words = text.match(/[A-Za-z]{3,}/g) ?? [];
  const functionWords = text.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/gi) ?? [];
  const alphabeticCharacters = text.match(/[A-Za-z]/g)?.length ?? 0;
  const hasStrongMath = /[=+*/∑∫√≤≥≈≠×÷\d]|(?:^|\s)-(?:\s|$)/u.test(text);
  // Vision often encloses an entire prose line merely because it contains an
  // inline equation. Keeping that wide rectangle as pixels leaves the prose
  // untranslated. Reject only regions whose inside text is clearly prose;
  // the inline-formula geometry pass below will preserve the mathematical
  // substring instead.
  return (words.length >= 6 && functionWords.length >= 2)
    // A hallucinated Vision formula box is sometimes only one short prose
    // continuation line (for example, "architecture to accelerate it").
    // Four natural words plus a function word are already incompatible with
    // a tight display-formula crop. Formula symbols embedded in a sentence
    // are reconstructed later from their character geometry.
    || (words.length >= 3 && functionWords.length >= 1 && alphabeticCharacters >= 18)
    // Short IEEE headings and prose tails are another recurring false
    // positive: Vision encloses a whole column-width line because an inline
    // footnote marker or italic heading resembles mathematics. A true formula
    // crop of this width still carries an operator or a digit.
    || (!hasStrongMath && (words.length >= 3 || alphabeticCharacters >= 14));
}

function formulaDuplicatesNumericProseTail(doc: Doc, asset: DetectedAssetRegion): boolean {
  if (asset.kind !== 'formula' || asset.rect.h > 28) return false;
  return doc.blocks.some((block) => {
    if (block.pageIndex !== asset.pageIndex || block.type !== 'paragraph') return false;
    const source = block.text?.replace(/\s+/g, ' ').trim() ?? '';
    const percentages = source.match(/\d+(?:\.\d+)?\s*(?:%|‰)/g) ?? [];
    if (percentages.length < 2 || !/\brespectively\b/i.test(source)) return false;
    const horizontalOverlap = Math.max(0, Math.min(
      block.rect.x + block.rect.w,
      asset.rect.x + asset.rect.w,
    ) - Math.max(block.rect.x, asset.rect.x));
    const verticalGap = Math.max(
      0,
      block.rect.y - (asset.rect.y + asset.rect.h),
      asset.rect.y - (block.rect.y + block.rect.h),
    );
    // Statistics at the end of a natural-language sentence are translated as
    // text and already protected by the numeric-token protocol. A shallow
    // Vision proposal on the same baseline would only mask part of that list.
    return horizontalOverlap >= Math.min(block.rect.w, asset.rect.w) * 0.25
      && verticalGap <= 4;
  });
}

function looksLikeTableNoteText(value: string | undefined): boolean {
  const source = value?.trim() ?? '';
  if (!source || !/^(?:\(\d+[a-z]?\)|\[\d+[a-z]?\]|[*†‡])\s+/i.test(source)) return false;
  const noteMarkers = source.match(/(?:^|\n)\s*(?:\(\d+[a-z]?\)|\[\d+[a-z]?\]|[*†‡])\s+/gim) ?? [];
  const words = source.match(/[A-Za-z]{3,}/g) ?? [];
  const formulaSymbols = source.match(/[=∑∏∫√≤≥≈≠]/gu) ?? [];
  return noteMarkers.length >= 2
    || (noteMarkers.length === 1 && words.length >= 6 && formulaSymbols.length === 0);
}

function trimTableBeforeFollowingProse(
  doc: Doc,
  asset: DetectedAssetRegion,
): DetectedAssetRegion {
  if (asset.kind !== 'table') return asset;
  const assetBottom = asset.rect.y + asset.rect.h;
  const naturalLanguageLine = (value: string): boolean => {
    const words = value.match(/[A-Za-z]{3,}/g) ?? [];
    const functionWords = value.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|while)\b/gi) ?? [];
    return words.length >= 8 && functionWords.length >= 2;
  };
  const firstProseLineTop = (block: Doc['blocks'][number], fallbackRect: Rect): number | undefined => {
    // Numbered notes immediately below a table are part of the immutable
    // technical object. Treating their natural-language sentences as body
    // prose trims the crop through the note and can silently drop later notes.
    if (looksLikeTableNoteText(block.text)) return undefined;
    const source = block.text ?? '';
    const lines = source.split(/\r?\n/);
    let sourceOffset = 0;
    for (const line of lines) {
      const start = sourceOffset;
      const end = start + line.length;
      sourceOffset = end + 1;
      if (!naturalLanguageLine(line)) continue;
      const characters = (block.characterRects ?? []).filter((character) => (
        character.pageIndex === asset.pageIndex
        && character.sourceIndex >= start
        && character.sourceIndex < end
        && character.ch.trim().length > 0
      ));
      const lineRect = unionRects(characters.map((character) => character.rect));
      if (lineRect) return lineRect.y;
      // A multi-line aggregate can begin with table rows and end in prose.
      // Without character geometry there is no safe line-level cut point.
      if (lines.length > 1) return undefined;
      return fallbackRect.y;
    }
    return undefined;
  };
  const proseTop = doc.blocks
    .map((block) => {
      const rect = physicalRectOnPage(block, asset.pageIndex);
      return rect ? { block, rect, proseTop: firstProseLineTop(block, rect) } : undefined;
    })
    .filter((candidate): candidate is {
      block: Doc['blocks'][number]; rect: Rect; proseTop: number;
    } => candidate !== undefined && candidate.proseTop !== undefined)
    .filter(({ block, rect, proseTop: candidateProseTop }) => {
      if (block.type !== 'paragraph') return false;
      const horizontalOverlap = Math.max(0, Math.min(
        rect.x + rect.w,
        asset.rect.x + asset.rect.w,
      ) - Math.max(rect.x, asset.rect.x));
      return horizontalOverlap >= Math.min(rect.w, asset.rect.w) * 0.25
        && candidateProseTop > asset.rect.y + Math.min(24, asset.rect.h * 0.35)
        && candidateProseTop < assetBottom - 2;
    })
    .map(({ proseTop: candidateProseTop }) => candidateProseTop)
    .sort((left, right) => left - right)[0];
  if (proseTop === undefined) return asset;
  const trimmedHeight = proseTop - asset.rect.y - 2;
  if (trimmedHeight < 12 || trimmedHeight < asset.rect.h * 0.45) return asset;
  return { ...asset, rect: { ...asset.rect, h: trimmedHeight } };
}

function extendTableThroughClippedTailLine(
  doc: Doc,
  asset: DetectedAssetRegion,
): DetectedAssetRegion {
  if (asset.kind !== 'table') return asset;
  const assetBottom = asset.rect.y + asset.rect.h;
  const tableNoteBottom = doc.blocks
    .filter((block) => block.pageIndex === asset.pageIndex)
    .map((block) => {
      const rect = physicalRectOnPage(block, asset.pageIndex);
      const source = block.text?.trim() ?? '';
      if (!rect || !source) return undefined;
      if (!looksLikeTableNoteText(source)) return undefined;
      const horizontalOverlap = Math.max(0, Math.min(
        rect.x + rect.w,
        asset.rect.x + asset.rect.w,
      ) - Math.max(rect.x, asset.rect.x));
      if (horizontalOverlap < Math.min(rect.w, asset.rect.w) * 0.25) return undefined;
      // The note must already touch the proposed crop (or begin within the
      // same baseline gap). This prevents a later numbered body list from
      // being absorbed merely because it shares the table's horizontal lane.
      if (rect.y > assetBottom + 4 || rect.y + rect.h <= asset.rect.y + 12) return undefined;
      return rect.y + rect.h + 2;
    })
    .filter((bottom): bottom is number => bottom !== undefined)
    .sort((left, right) => right - left)[0];
  const clippedBottom = doc.blocks
    .map((block) => physicalRectOnPage(block, asset.pageIndex))
    .filter((rect): rect is Rect => Boolean(rect))
    .filter((rect) => {
      const horizontalOverlap = Math.max(0, Math.min(
        rect.x + rect.w,
        asset.rect.x + asset.rect.w,
      ) - Math.max(rect.x, asset.rect.x));
      const overflow = rect.y + rect.h - assetBottom;
      return horizontalOverlap >= Math.min(rect.w, asset.rect.w) * 0.25
        // A Vision boundary may land through the final table-note baseline.
        // Extend only that short crossing line; a following prose paragraph
        // starts below the boundary and must remain translatable text.
        && rect.y < assetBottom
        && rect.y >= assetBottom - 18
        && overflow > 0
        && overflow <= 12;
    })
    .map((rect) => rect.y + rect.h + 2)
    .sort((left, right) => right - left)[0];
  const extendedBottom = Math.max(assetBottom, tableNoteBottom ?? assetBottom, clippedBottom ?? assetBottom);
  if (extendedBottom <= assetBottom) return asset;
  return { ...asset, rect: { ...asset.rect, h: extendedBottom - asset.rect.y } };
}

function normalizedFragmentText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, '').replace(/[.,;:()[\]{}]/g, '');
}

function nestedPdfFragmentIds(doc: Doc): Set<string> {
  const result = new Set<string>();
  for (const candidate of doc.blocks) {
    // A short caption such as "TABLE IV" can geometrically sit inside a
    // larger PDF text aggregate for the table body.  It is still structural
    // content and may be the only stable caption anchor returned by Vision.
    if (candidate.type === 'caption' || candidate.type === 'section' || candidate.type === 'title') continue;
    const text = candidate.text?.trim() ?? '';
    const naturalWords = text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
    const fragmentLike = naturalWords <= 2
      && (text.length <= 16 || /[=+\-*/∑∫√≤≥≈≠⌈⌉λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω\d]/u.test(text));
    if (!fragmentLike) continue;
    const candidateText = normalizedFragmentText(text);
    const belongsToFormulaCluster = physicalPages(candidate).some((pageIndex) => {
      const candidateRect = physicalRectOnPage(candidate, pageIndex);
      const page = doc.pages[pageIndex];
      if (!candidateRect || !page) return false;
      return doc.blocks.some((other) => {
        if (other.id === candidate.id || !['paragraph', 'equation'].includes(other.type)) return false;
        const otherText = other.text?.trim() ?? '';
        const otherWords = otherText.match(/[A-Za-z]{3,}/g)?.length ?? 0;
        if (
          otherWords > 4
          || !/[=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(otherText)
        ) return false;
        const otherRect = physicalRectOnPage(other, pageIndex);
        if (!otherRect) return false;
        const horizontalGap = Math.max(
          0,
          otherRect.x - (candidateRect.x + candidateRect.w),
          candidateRect.x - (otherRect.x + otherRect.w),
        );
        const verticalGap = Math.max(
          0,
          otherRect.y - (candidateRect.y + candidateRect.h),
          candidateRect.y - (otherRect.y + otherRect.h),
        );
        const combined = unionRect(candidateRect, otherRect);
        return horizontalGap <= 36
          && verticalGap <= 24
          && combined.w <= page.width * 0.8
          && combined.h <= 96;
      });
    });
    // A parser equation anchor and its detached limits/labels can each be
    // geometrically nested in another math block. Keep the connected group so
    // the later character-level formula reconstruction can crop it once.
    if (belongsToFormulaCluster) continue;
    const nested = physicalPages(candidate).some((pageIndex) => {
      const physicalCandidateRect = physicalRectOnPage(candidate, pageIndex);
      const candidateRects = [
        physicalCandidateRect,
        candidate.pageIndex === pageIndex ? candidate.rect : undefined,
      ].filter((rect): rect is Rect => Boolean(rect));
      if (!candidateRects.length) return false;
      return doc.blocks.some((other) => {
        if (other.id === candidate.id) return false;
        const otherRects = [
          physicalRectOnPage(other, pageIndex),
          other.pageIndex === pageIndex ? other.rect : undefined,
        ].filter((rect): rect is Rect => Boolean(rect));
        if (!otherRects.length) return false;
        const otherText = other.text ?? '';
        const otherWords = otherText.match(/[A-Za-z]{3,}/g)?.length ?? 0;
        if (otherWords < 3) return false;
        if (candidate.type === 'equation') {
          const otherHasMath = /[=+\-*/∑∫√≤≥≈≠⌈⌉λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(otherText);
          const otherContainsCandidate = candidateText.length >= 2
            && normalizedFragmentText(otherText).includes(candidateText);
          if (!otherHasMath && !otherContainsCandidate) return false;
        }
        return candidateRects.some((candidateRect) => {
          const area = Math.max(1, candidateRect.w * candidateRect.h);
          return otherRects.some((otherRect) => (
            otherRect.w * otherRect.h >= area * 2
            && intersectionArea(candidateRect, otherRect) / area >= 0.65
          ));
        });
      });
    });
    if (nested) result.add(candidate.id);
  }
  return result;
}

function withoutScatteredMathLines(source: string): string {
  const lines = source.split(/\r?\n/).map((line) => line.replace(/[ \t]+/g, ' ').trim());
  const naturalWordCount = (line: string) => line.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  const ordinaryShortWords = new Set([
    'a', 'an', 'as', 'at', 'be', 'by', 'do', 'for', 'if', 'in', 'is', 'it',
    'no', 'of', 'on', 'or', 'so', 'to', 'up', 'we',
  ]);
  if (!lines.some((line) => naturalWordCount(line) >= 2)) return source.trim();
  const filtered = lines.filter((line) => {
      if (!line) return false;
      if (naturalWordCount(line) >= 2) return true;
      if (line.length > 40) return true;
      return !(/[=+\-*/∑∫√≤≥≈≠⌈⌉⎧⎨⎩⎫⎬⎭λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω\d]/u.test(line)
        || /^(?:[A-Za-z]\s*){1,4}$/u.test(line));
    });
  const cleaned = filtered.map((line, lineIndex) => {
      const firstWord = line.match(/[A-Za-z]{3,}/);
      if (!firstWord?.index) return line;
      const prefix = line.slice(0, firstWord.index);
      if (prefix.length > 20 || /^\s*\d+[.)]\s*$/.test(prefix)) return line;
      const fragmentPrefix = prefix.trim();
      if (!fragmentPrefix || /[A-Za-z]{3,}/.test(fragmentPrefix)) return line;
      const shortWords = fragmentPrefix.match(/[A-Za-z]+/g) ?? [];
      // Line wrapping legitimately places short English function words before
      // the first 3+ letter word ("in the process", "to the pipeline",
      // "on-chip"). They are prose, not detached equation glyphs. Likewise,
      // an opening bracket belongs to the following word. Strip a prefix only
      // when it carries actual mathematical evidence or consists solely of
      // isolated one-letter variables such as "m P .".
      if (/^[([{'"“‘]+\s*$/.test(fragmentPrefix)) return line;
      if (shortWords.length > 0
        && shortWords.every((word) => ordinaryShortWords.has(word.toLocaleLowerCase()))) return line;
      if (/^[-+]?\d+(?:[.,]\d+)?%?(?:\s*(?:×|x))?\s*$/i.test(fragmentPrefix)) return line;
      // A display expression may wrap immediately after a binary operator,
      // with its remaining terms followed by explanatory prose on this line.
      // That prefix is part of the equation, not an unrelated PDF glyph run.
      if (/[-=+*/]\s*$/.test(filtered[lineIndex - 1]?.trim() ?? '')) return line;
      const mathematicalPrefix = /[=+*/∑∫√≤≥≈≠⌈⌉⎧⎨⎩⎫⎬⎭λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω\d]/u.test(fragmentPrefix)
        || (shortWords.length > 0 && shortWords.every((word) => word.length === 1));
      if (!mathematicalPrefix) return line;
      return line.slice(firstWord.index);
    });
  return cleaned.join('\n').trim();
}

function hasScatteredMathLinesAroundProse(source: string): boolean {
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const naturalProseIndex = lines.findIndex((line) => {
    const words = line.match(/[A-Za-z]{3,}/g) ?? [];
    const functionWords = line.match(
      /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|shown)\b/gi,
    ) ?? [];
    return words.length >= 3 && functionWords.length >= 1;
  });
  // A normal paragraph followed by a displayed equation is legitimate. This
  // recovery is for the inverse pattern emitted by PDF.js: detached formula
  // glyph lines first, then one real prose continuation (and often more math).
  if (naturalProseIndex <= 0) return false;
  const isMathFragment = (line: string): boolean => {
    const naturalWords = line.match(/[A-Za-z]{3,}/g)?.length ?? 0;
    if (naturalWords >= 2 || line.length > 40) return false;
    return /[=+\-*/∑∫√≤≥≈≠⌈⌉⎧⎨⎩⎫⎬⎭λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω\d]/u.test(line)
      || /^(?:[A-Za-z]\s*){1,4}$/u.test(line);
  };
  return lines.slice(0, naturalProseIndex).filter(isMathFragment).length >= 2;
}

function normalizeDetachedSubscriptLines(source: string): string {
  const lines = source.split(/\r?\n/);
  const sentenceWords = new Set([
    'the', 'this', 'that', 'these', 'those', 'when', 'where', 'while', 'although',
    'however', 'therefore', 'because', 'since', 'for', 'from', 'with', 'without',
    'into', 'onto', 'each', 'one', 'we', 'it', 'our',
  ]);
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index + 1]?.trim();
    if (!marker || !/^[A-Za-z]{2,6}$/.test(marker)) {
      result.push(lines[index]!);
      continue;
    }
    let markerCount = 0;
    while (lines[index + markerCount + 1]?.trim().toLocaleLowerCase() === marker.toLocaleLowerCase()) {
      markerCount += 1;
    }
    // Detached subscripts emitted by PDF.js occur as repeated identical rows
    // after the variables on the preceding prose line. Requiring at least two
    // prevents ordinary one-word wrapped lines from being rewritten.
    if (markerCount < 2) {
      result.push(lines[index]!);
      continue;
    }
    const collapsed = lines[index]!.replace(/\b([A-Z])\s+([a-z][A-Za-z]{2,})\b/g, '$1$2');
    const variablePattern = /\b(?:[A-Z][a-zA-Z]{2,}|[a-z]+[A-Z][A-Za-z]*)\b/g;
    const candidates = [...collapsed.matchAll(variablePattern)]
      .filter((match) => !sentenceWords.has(match[0].toLocaleLowerCase()));
    if (candidates.length < markerCount) {
      result.push(lines[index]!);
      continue;
    }
    let candidateIndex = 0;
    const normalized = collapsed.replace(variablePattern, (word) => {
      if (sentenceWords.has(word.toLocaleLowerCase()) || candidateIndex >= markerCount) return word;
      candidateIndex += 1;
      return `${word}_${marker}`;
    });
    result.push(normalized);
    index += markerCount;
  }
  return result.join('\n').trim();
}

function nearVerifiedFormula(
  block: Doc['blocks'][number],
  assets: readonly DetectedAssetRegion[],
): boolean {
  return assets.some((asset) => {
    if (asset.kind !== 'formula') return false;
    const rect = physicalRectOnPage(block, asset.pageIndex);
    if (!rect) return false;
    const horizontalOverlap = Math.max(0, Math.min(
      rect.x + rect.w,
      asset.rect.x + asset.rect.w,
    ) - Math.max(rect.x, asset.rect.x));
    const verticalGap = Math.max(
      0,
      rect.y - (asset.rect.y + asset.rect.h),
      asset.rect.y - (rect.y + rect.h),
    );
    return horizontalOverlap >= Math.min(rect.w, asset.rect.w) * 0.1 && verticalGap <= 48;
  });
}

function isFormulaExtractionFragment(block: Doc['blocks'][number], asset: DetectedAssetRegion): boolean {
  if (asset.kind !== 'formula') return false;
  const rect = physicalRectOnPage(block, asset.pageIndex);
  if (!rect) return false;
  const text = block.text?.trim() ?? '';
  const naturalWords = text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  const functionWords = text.match(
    /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/gi,
  ) ?? [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fragmentedFormula = functionWords.length === 0
    && lines.length >= 3
    && lines.filter((line) => line.length <= 16).length / lines.length >= 0.7;
  if ((naturalWords > 2 && !fragmentedFormula)
    || !/[=+\-*/∑∫√≤≥≈≠⌈⌉⎧⎨⎩λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω\d]/u.test(text)) return false;
  return intersectionArea(rect, asset.rect) / Math.max(1, rect.w * rect.h) >= 0.05;
}

function withoutAssetTextLines(
  block: Doc['blocks'][number],
  source: string,
  assets: readonly DetectedAssetRegion[],
): string {
  if (!block.characterRects?.length || !assets.length) return source;
  const blockText = block.text ?? '';
  const sourceOffset = blockText.indexOf(source);
  if (sourceOffset >= 0) {
    const protectedFormulaOverlapIndexes = new Set<number>();
    let lineOffset = 0;
    for (const line of blockText.split(/\r?\n/)) {
      const lineStart = lineOffset;
      const lineEnd = lineStart + line.length;
      lineOffset = lineEnd + 1;
      if ((line.match(/[A-Za-z]{3,}/g)?.length ?? 0) < 5) continue;
      const lineCharacters = block.characterRects.filter((character) => (
        character.sourceIndex >= lineStart
        && character.sourceIndex < lineEnd
        && character.ch.trim().length > 0
      ));
      if (!lineCharacters.length) continue;
      for (const asset of assets) {
        const inlineOwner = asset.id.match(/^(.*)-inline-formula(?:-\d+)?$/)?.[1];
        if (asset.kind !== 'formula' || !inlineOwner || inlineOwner === block.id) continue;
        const overlapping = lineCharacters.filter((character) => {
          if (character.pageIndex !== asset.pageIndex) return false;
          return assetCompositesSourceCharacter(asset, block, character);
        });
        // Formula crops include a small safety pad for subscripts. If that pad
        // merely clips part of a natural-language line owned by another PDF
        // block, preserve the line instead of deleting a convincing-looking
        // substring from the sentence. Formula assets derived from this block
        // remain authoritative and still mask their exact inline expression.
        if (overlapping.length > 0 && overlapping.length / lineCharacters.length < 0.6) {
          overlapping.forEach((character) => protectedFormulaOverlapIndexes.add(character.sourceIndex));
        }
      }
    }
    const masked = new Uint8Array(source.length);
    for (const character of block.characterRects) {
      const insideAsset = assets.some((asset) => (
        character.pageIndex === asset.pageIndex
        && assetCompositesSourceCharacter(asset, block, character)
        && !protectedFormulaOverlapIndexes.has(character.sourceIndex)
      ));
      if (!insideAsset) continue;
      const localStart = character.sourceIndex - sourceOffset;
      const localEnd = localStart + character.ch.length;
      for (let index = Math.max(0, localStart); index < Math.min(source.length, localEnd); index += 1) {
        masked[index] = 1;
      }
    }
    if (masked.some((value) => value === 1)) {
      let cleaned = '';
      for (let index = 0; index < source.length; index += 1) {
        cleaned += masked[index] ? ' ' : source[index];
      }
      return cleaned
        .split(/\r?\n/)
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
        .trim();
    }
    // The source can be a cleaned suffix of the raw block.  When its exact
    // offset is known and no character in that suffix intersects an asset,
    // the coordinate mask is complete; falling through would compare local
    // line offsets with raw-block indexes and could delete valid prose.
    return source;
  }
  let searchOffset = 0;
  const kept: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    let start = blockText.indexOf(line, searchOffset);
    if (start < 0 && line.trim() !== line) start = blockText.indexOf(line.trim(), searchOffset);
    if (start < 0) {
      kept.push(line);
      continue;
    }
    const end = start + line.length;
    searchOffset = end + 1;
    const characters = block.characterRects.filter((character) => (
      character.sourceIndex >= start
      && character.sourceIndex < end
      && character.ch.trim().length > 0
    ));
    if (!characters.length) {
      kept.push(line);
      continue;
    }
    const inside = characters.filter((character) => assets.some((asset) => {
      if (character.pageIndex !== asset.pageIndex) return false;
      return assetCompositesSourceCharacter(asset, block, character);
    })).length;
    if (inside / characters.length < 0.6) kept.push(line);
  }
  return kept.join('\n').trim();
}

function separateOverlappingArxivMetadata(doc: Doc, units: SemanticUnit[]): void {
  for (const block of doc.blocks) {
    const match = block.text?.match(/^(arXiv:\S+\s+\[[^\]]+\]\s+\d{1,2}\s+[A-Za-z]+\s+\d{4})\s+(.+)$/);
    if (!match || !block.characterRects?.length) continue;
    const metadata = match[1]!;
    const suffix = match[2]!;
    const suffixStart = block.text!.indexOf(suffix);
    const suffixCharacters = block.characterRects.filter((character) => character.sourceIndex >= suffixStart);
    if (!suffixCharacters.length) continue;
    const centerX = (Math.min(...suffixCharacters.map((character) => character.rect.x))
      + Math.max(...suffixCharacters.map((character) => character.rect.x + character.rect.w))) / 2;
    const centerY = (Math.min(...suffixCharacters.map((character) => character.rect.y))
      + Math.max(...suffixCharacters.map((character) => character.rect.y + character.rect.h))) / 2;
    const targetBlock = doc.blocks
      .filter((candidate) => (
        candidate.id !== block.id
        && candidate.pageIndex === block.pageIndex
        && candidate.type === 'paragraph'
        && centerX >= candidate.rect.x && centerX <= candidate.rect.x + candidate.rect.w
        && centerY >= candidate.rect.y && centerY <= candidate.rect.y + candidate.rect.h
      ))
      .sort((left, right) => left.rect.w * left.rect.h - right.rect.w * right.rect.h)[0];
    const metadataUnit = units.find((unit) => unit.id === block.id);
    const targetUnit = targetBlock ? units.find((unit) => unit.id === targetBlock.id) : undefined;
    if (!metadataUnit || !targetBlock || !targetUnit?.sourceText) continue;
    const nextCharacter = (targetBlock.characterRects ?? [])
      .filter((character) => character.rect.y > centerY + 2)
      .sort((left, right) => left.rect.y - right.rect.y || left.sourceIndex - right.sourceIndex)[0];
    const insertion = Math.min(targetUnit.sourceText.length, nextCharacter?.sourceIndex ?? targetUnit.sourceText.length);
    targetUnit.sourceText = [
      targetUnit.sourceText.slice(0, insertion).trimEnd(),
      suffix,
      targetUnit.sourceText.slice(insertion).trimStart(),
    ].filter(Boolean).join('\n');
    metadataUnit.sourceText = metadata;
    metadataUnit.kind = 'reference';
    metadataUnit.protectedTokens = extractProtectedTokens(metadata);
  }
}

function withoutEmbeddedMarginFurniture(doc: Doc, block: Doc['blocks'][number], source: string): string {
  if (!block.characterRects?.length || !/\r?\n/.test(source)) return source;
  const rawSource = block.text ?? '';
  let searchOffset = 0;
  const lines = source.split(/\r?\n/).map((line) => {
    let start = rawSource.indexOf(line, searchOffset);
    if (start < 0 && line.trim() !== line) start = rawSource.indexOf(line.trim(), searchOffset);
    if (start < 0) start = searchOffset;
    const end = start + line.length;
    searchOffset = Math.min(rawSource.length, end + 1);
    const characters = block.characterRects!.filter((character) => (
      character.sourceIndex >= start
      && character.sourceIndex < end
      && character.ch.trim().length > 0
    ));
    const nearMargin = characters.filter((character) => {
      const page = doc.pages[character.pageIndex];
      if (!page) return false;
      const centerY = character.rect.y + character.rect.h / 2;
      const outsideOwningBlock = character.pageIndex !== block.pageIndex
        || centerY < block.rect.y - 12
        || centerY > block.rect.y + block.rect.h + 12;
      // Ordinary body text in IEEE papers legitimately begins near 8% of the
      // page height. It is furniture only when its geometry is an embedded
      // outlier from this block (typically a next-page running header).
      return outsideOwningBlock && (centerY < page.height * 0.1 || centerY > page.height * 0.92);
    }).length;
    return { line, furniture: characters.length > 0 && nearMargin / characters.length >= 0.8 };
  });
  if (!lines.some((line) => line.furniture) || !lines.some((line) => !line.furniture && line.line.trim())) {
    return source;
  }
  return lines.filter((line) => !line.furniture).map((line) => line.line).join('\n').trim();
}

function withoutPublisherBoilerplate(source: string): string {
  const lines = source.split(/\r?\n/);
  let inPermissionNotice = false;
  return lines.filter((line) => {
    const trimmed = line.trim();
    if (/^Corresponding author\s*:/i.test(trimmed)) return false;
    if (/^[*∗†‡]\s*This paper (?:has been|was) accepted\b/i.test(trimmed)) return false;
    if (/^Permission to make (?:digital or hard|digital|hard) copies\b/i.test(trimmed)) {
      inPermissionNotice = true;
      return false;
    }
    if (inPermissionNotice) {
      if (/\bdoi\.org\//i.test(trimmed)) inPermissionNotice = false;
      return false;
    }
    return !(
      /^(?:©\s*)?\d{4}\s+Copyright\b/i.test(trimmed)
      || /^ACM ISBN\b/i.test(trimmed)
      || /^https?:\/\/doi\.org\//i.test(trimmed)
      || /^DAC\s*[’']?\d{2}\s*,\s*(?:June|July|August)\b/i.test(trimmed)
    );
  }).join('\n').trim();
}

function normalizedFurnitureLine(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function repeatedEmbeddedFurnitureLines(doc: Doc): Set<string> {
  const occurrences = new Map<string, Array<{ standalone: boolean; nearMargin: boolean }>>();
  for (const block of doc.blocks) {
    const lines = (block.text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const finalLine = lines.at(-1);
    if (!finalLine || finalLine.length < 6 || finalLine.length > 180) continue;
    const pageHeight = doc.pages[block.pageIndex]?.height ?? doc.meta.paperHeight;
    const nearMargin = block.rect.y < pageHeight * 0.12
      || block.rect.y + block.rect.h > pageHeight * 0.92;
    const key = normalizedFurnitureLine(finalLine);
    const records = occurrences.get(key) ?? [];
    records.push({ standalone: lines.length === 1, nearMargin });
    occurrences.set(key, records);
  }

  const result = new Set<string>();
  for (const [key, records] of occurrences) {
    if (records.length < 2) continue;
    const looksLikeAuthor = /\bet\s+al\.?$/i.test(key);
    const looksLikeRunningTitle = key.length >= 45 && /[a-z]/i.test(key);
    const repeatedlyObserved = records.length >= 3;
    const hasStandaloneMarginCopy = records.some((record) => record.standalone && record.nearMargin);
    if ((looksLikeAuthor || looksLikeRunningTitle || repeatedlyObserved) && (hasStandaloneMarginCopy || repeatedlyObserved)) {
      result.add(key);
    }
  }
  return result;
}

function withoutRepeatedEmbeddedFurniture(
  doc: Doc,
  block: Doc['blocks'][number],
  source: string,
  repeatedLines: ReadonlySet<string>,
): string {
  if (!repeatedLines.size || !source.trim()) return source;
  const lines = source.split(/\r?\n/);
  if (lines.length === 1) {
    const pageHeight = doc.pages[block.pageIndex]?.height ?? doc.meta.paperHeight;
    const nearMargin = block.rect.y < pageHeight * 0.12
      || block.rect.y + block.rect.h > pageHeight * 0.92;
    // Keep the real document title on the first page. Repeated standalone
    // copies on later page margins are running furniture.
    return block.pageIndex > 0 && nearMargin && repeatedLines.has(normalizedFurnitureLine(source))
      ? ''
      : source;
  }
  return lines
    .filter((line) => !repeatedLines.has(normalizedFurnitureLine(line)))
    .join('\n')
    .trim();
}

function withoutTrailingVisualLabelCluster(source: string): string {
  const lines = source.split(/\r?\n/);
  // Symbol-font text embedded in figures is occasionally decoded by PDF.js as
  // Syriac/Arabic-extension or Indic glyphs.  Once such a line appears near
  // the end of an otherwise English prose block, remove it together with the
  // immediately preceding short diagram labels.  The pixels remain available
  // through the immutable figure asset; only the duplicate text layer is
  // discarded here.
  const suspiciousGlyph = /[\u0700-\u08ff\u0a80-\u0bff]/u;
  const firstSuspicious = lines.findIndex((line) => suspiciousGlyph.test(line));
  if (firstSuspicious > 0) {
    const diagramLabel = (value: string): boolean => {
      const line = value.trim();
      if (!line || line.length > 64 || /[.!?;:]\s*$/.test(line)) return false;
      if (/^(?:def\s+\w+\s*\(|return\b|pre-?processing\b)/i.test(line)) return true;
      if (/^(?:[A-Z][A-Z0-9-]*)(?:\s+[A-Z][A-Z0-9-]*){0,5}$/.test(line)) return true;
      return /^(?:POLY|MSM|INTT|NTT|PMULT|PADD|PDBL|MUX)(?:\s+.*)?$/i.test(line);
    };
    let cut = firstSuspicious;
    while (cut > 0 && diagramLabel(lines[cut - 1]!)) cut -= 1;
    return lines.slice(0, cut).join('\n').trim();
  }

  if (lines.length < 7) return source;
  let start = lines.length;
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const line = lines[index]!.trim();
    const words = line.match(/[A-Za-z][A-Za-z0-9_.-]*/g)?.length ?? 0;
    const labelLike = line.length > 0
      && line.length <= 42
      && !/[.!?;:]\s*$/.test(line)
      && (words <= 5 || /^[\d\s.,%+\-×]+$/.test(line));
    if (!labelLike) break;
    start = index;
  }
  const suffix = lines.slice(start).map((line) => line.trim()).filter(Boolean);
  if (suffix.length < 6) return source;
  const numericLines = suffix.filter((line) => /\d/.test(line)).length;
  const chartTerms = suffix.filter((line) => (
    /\b(?:proportion|speedup|benchmark|mod(?:add|reduce|exp|inv)|mmac|rsa|json|tendermint|trace generation)\b/i.test(line)
  )).length;
  if (numericLines < 3 || chartTerms < 1) return source;
  return lines.slice(0, start).join('\n').trim();
}

function unionRect(left: Doc['blocks'][number]['rect'], right: Doc['blocks'][number]['rect']) {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const r = Math.max(left.x + left.w, right.x + right.w);
  const b = Math.max(left.y + left.h, right.y + right.h);
  return { x, y, w: r - x, h: b - y };
}

function formulaContinuation(anchor: Doc['blocks'][number], candidate: Doc['blocks'][number]): boolean {
  if (candidate.id === anchor.id || candidate.pageIndex !== anchor.pageIndex) return false;
  if (candidate.type !== 'paragraph') return false;
  if (candidate.rect.h > Math.max(36, anchor.rect.h * 4)) return false;
  const text = candidate.text?.trim() ?? '';
  if (!text || text.length > 120 || (text.match(/[A-Za-z]{3,}/g)?.length ?? 0) > 4) return false;
  if (!/[=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(text)) return false;
  const verticalGap = Math.max(
    0,
    candidate.rect.y - (anchor.rect.y + anchor.rect.h),
    anchor.rect.y - (candidate.rect.y + candidate.rect.h),
  );
  const horizontalOverlap = Math.max(0, Math.min(
    anchor.rect.x + anchor.rect.w,
    candidate.rect.x + candidate.rect.w,
  ) - Math.max(anchor.rect.x, candidate.rect.x));
  return verticalGap <= 18 && horizontalOverlap > 0;
}

interface FormulaGlyphCluster {
  rect: Rect;
  fragmentIds: Set<string>;
  prefixIds: Set<string>;
}

interface FormulaGlyphCandidate {
  block: Doc['blocks'][number];
  rect: Rect;
  /** A mathematical prefix cut from a mixed block whose remaining lines are prose. */
  prefixOnly: boolean;
}

function leadingFormulaGlyphRect(
  block: Doc['blocks'][number],
  pageIndex: number,
): Rect | undefined {
  if (!block.characterRects?.length || !/\r?\n/.test(block.text ?? '')) return undefined;
  const source = block.text ?? '';
  let offset = 0;
  let formulaLines = 0;
  let hasStrongMath = false;
  let followedByProse = false;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const line of source.split(/\r?\n/)) {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const words = trimmed.match(/[A-Za-z]{3,}/g) ?? [];
    const functionWords = trimmed.match(
      /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/gi,
    ) ?? [];
    if (words.length >= 5 && functionWords.length >= 1) {
      followedByProse = formulaLines > 0;
      break;
    }
    const strongMath = /[=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(trimmed);
    const equationLabel = /^\(\s*\d+[a-z]?\s*\)$/i.test(trimmed);
    if (words.length > 4 || (!strongMath && !equationLabel)) break;
    ranges.push({ start, end });
    formulaLines += 1;
    hasStrongMath ||= strongMath;
  }
  if (!followedByProse || !hasStrongMath || !ranges.length) return undefined;
  const characters = block.characterRects.filter((character) => (
    character.pageIndex === pageIndex
    && character.ch.trim().length > 0
    && ranges.some((range) => character.sourceIndex >= range.start && character.sourceIndex < range.end)
  ));
  return unionRects(characters.map((character) => character.rect));
}

function withoutLeadingFormulaLines(source: string): string {
  const lines = source.split(/\r?\n/);
  let formulaLines = 0;
  let hasStrongMath = false;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (!trimmed) continue;
    const words = trimmed.match(/[A-Za-z]{3,}/g) ?? [];
    const functionWords = trimmed.match(
      /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/gi,
    ) ?? [];
    if (words.length >= 5 && functionWords.length >= 1) {
      return formulaLines > 0 && hasStrongMath
        ? lines.slice(index).join('\n').trim()
        : source;
    }
    const strongMath = /[=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(trimmed);
    const equationLabel = /^\(\s*\d+[a-z]?\s*\)$/i.test(trimmed);
    if (words.length > 4 || (!strongMath && !equationLabel)) return source;
    formulaLines += 1;
    hasStrongMath ||= strongMath;
  }
  return source;
}

function withoutDetachedVariableLines(source: string): string {
  const lines = source.split(/\r?\n/);
  if (lines.length < 2) return source;
  const naturalLine = lines.some((line) => {
    const words = line.match(/[A-Za-z]{3,}/g) ?? [];
    const functionWords = line.match(
      /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|each)\b/gi,
    ) ?? [];
    return words.length >= 3 && functionWords.length >= 1;
  });
  if (!naturalLine) return source;
  return lines
    // PDF symbol-font subscripts are often emitted as late standalone lines
    // such as `i` or `i i`. Their visible glyphs are already inside the
    // neighbouring immutable formula crop; keeping the duplicate text makes
    // them appear as scattered prose.
    .filter((line) => !/^\s*[A-Za-z](?:\s+[A-Za-z]){0,3}\s*$/.test(line))
    .join('\n')
    .trim();
}

function formulaGlyphCluster(
  doc: Doc,
  anchor: Doc['blocks'][number],
  unitIds: ReadonlySet<string>,
): FormulaGlyphCluster | undefined {
  const page = doc.pages[anchor.pageIndex];
  if (!page) return undefined;
  const hasCharacterGeometry = Boolean(anchor.characterRects?.length || anchor.charRects?.length);
  if (!hasCharacterGeometry && (anchor.rect.w > page.width * 0.6 || anchor.rect.h > 72)) {
    return undefined;
  }
  const candidates = doc.blocks.flatMap((candidate): FormulaGlyphCandidate[] => {
    if (
      candidate.pageIndex !== anchor.pageIndex
      || !['paragraph', 'equation'].includes(candidate.type)
    ) return [];
    const text = candidate.text?.trim() ?? '';
    const naturalWords = text.match(/[A-Za-z]{3,}/g) ?? [];
    if (!text) return [];
    const prefixRect = leadingFormulaGlyphRect(candidate, anchor.pageIndex);
    if (prefixRect) return [{ block: candidate, rect: prefixRect, prefixOnly: true }];
    if (
      text.length > 500
      || naturalWords.length > 4
      || !/[=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(text)
    ) return [];
    const characterRect = physicalRectOnPage(candidate, anchor.pageIndex);
    return characterRect ? [{ block: candidate, rect: characterRect, prefixOnly: false }] : [];
  });
  if (candidates.length < 2) return undefined;

  let combined = physicalRectOnPage(anchor, anchor.pageIndex) ?? { ...anchor.rect };
  const fragmentIds = new Set<string>();
  const prefixIds = new Set<string>();
  const remaining = [...candidates];
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const candidate = remaining[index]!;
      const horizontalGap = Math.max(
        0,
        candidate.rect.x - (combined.x + combined.w),
        combined.x - (candidate.rect.x + candidate.rect.w),
      );
      const verticalGap = Math.max(
        0,
        candidate.rect.y - (combined.y + combined.h),
        combined.y - (candidate.rect.y + candidate.rect.h),
      );
      // Consecutive display equations commonly keep roughly one text baseline
      // of vertical leading between their PDF glyph boxes.
      if (horizontalGap > 36 || verticalGap > 24) continue;
      const expandedRect = unionRect(combined, candidate.rect);
      if (expandedRect.w > page.width * 0.8 || expandedRect.h > 96) continue;
      combined = expandedRect;
      if (
        !candidate.prefixOnly
        && candidate.block.id !== anchor.id
        && unitIds.has(candidate.block.id)
      ) {
        fragmentIds.add(candidate.block.id);
      }
      if (candidate.prefixOnly && candidate.block.id !== anchor.id) {
        prefixIds.add(candidate.block.id);
      }
      remaining.splice(index, 1);
      expanded = true;
    }
  }
  if (!fragmentIds.size || combined.w > page.width * 0.8 || combined.h > 96) {
    return undefined;
  }
  return {
    rect: {
      x: Math.max(0, combined.x - 3),
      y: Math.max(0, combined.y - 2),
      w: combined.w + 6,
      h: combined.h + 4,
    },
    fragmentIds,
    prefixIds,
  };
}

function withoutTrailingFormulaFragment(source: string): string {
  const lines = source.split(/\r?\n/);
  let cut = lines.length;
  let containsMath = false;
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const tail = lines[index]!.trim();
    const naturalWords = tail.match(/[A-Za-z]{3,}/g) ?? [];
    const mathLike = /[=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(tail);
    const numericOnly = /^[\d\s.,()[\]{}]+$/.test(tail);
    if (tail.length > 100 || naturalWords.length > 1 || (!mathLike && !numericOnly)) break;
    cut = index;
    containsMath ||= mathLike;
  }
  return containsMath ? lines.slice(0, cut).join('\n').trim() : source.trim();
}

function isNaturalLanguageFormulaBlock(source: string | undefined): boolean {
  const text = source?.replace(/\s+/g, ' ').trim() ?? '';
  if (text.length < 45) return false;
  const words = text.match(/[A-Za-z]{3,}/g) ?? [];
  const functionWords = text.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/gi) ?? [];
  return words.length >= 5 && functionWords.length >= 2;
}

interface OperatorInlineFormulaGeometry {
  pageIndex: number;
  rect: Rect;
  preserveRects: Rect[];
  sourceRanges: Array<{ start: number; end: number }>;
  hint: string;
}

/**
 * Recover an inline expression led by a large operator when PDF text order
 * emits the limits on separate lines and the following prose in the same
 * narrow block. The ordinary inline path is equality-led; this path covers
 * expressions such as a bare summation between two clauses without guessing
 * or rewriting the formula.
 */
function operatorInlineFormulaGeometry(
  block: Doc['blocks'][number],
): OperatorInlineFormulaGeometry | undefined {
  const source = block.text ?? '';
  if (!block.characterRects?.length || !/[∑∏∫]/u.test(source) || !/\r?\n/.test(source)) return undefined;
  const ranges: Array<{ start: number; end: number; text: string }> = [];
  let offset = 0;
  let hasNaturalSuffix = false;
  let sawLargeOperator = false;
  for (const line of source.split(/\r?\n/)) {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    offset = lineEnd + 1;
    const firstNaturalWord = line.search(/[A-Za-z]{3,}/);
    if (firstNaturalWord >= 0) {
      const prefix = line.slice(0, firstNaturalWord).trim();
      if (prefix && /^[\s\dA-Za-z.,()[\]{}|^ˆ′'_=+\-*/∑∏∫√≤≥≈≠⌈⌉→←↦λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]+$/u.test(prefix)) {
        const prefixStart = line.indexOf(prefix);
        ranges.push({
          start: lineStart + prefixStart,
          end: lineStart + prefixStart + prefix.length,
          text: prefix,
        });
      }
      hasNaturalSuffix ||= sawLargeOperator;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 100) continue;
    const compactMath = /^[\s\dA-Za-z.,()[\]{}|^ˆ′'_=+\-*/∑∏∫√≤≥≈≠⌈⌉→←↦λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]+$/u.test(trimmed);
    if (!compactMath) continue;
    const startInLine = line.indexOf(trimmed);
    ranges.push({
      start: lineStart + startInLine,
      end: lineStart + startInLine + trimmed.length,
      text: trimmed,
    });
    sawLargeOperator ||= /[∑∏∫]/u.test(trimmed);
  }
  if (!hasNaturalSuffix || !ranges.some((range) => /[∑∏∫]/u.test(range.text))) return undefined;
  const characters = block.characterRects.filter((character) => (
    character.ch.trim()
    && ranges.some((range) => character.sourceIndex >= range.start && character.sourceIndex < range.end)
  ));
  if (!characters.length) return undefined;
  const pageIndex = characters[0]!.pageIndex;
  if (characters.some((character) => character.pageIndex !== pageIndex)) return undefined;
  const physical = unionRects(characters.map((character) => character.rect));
  if (!physical) return undefined;
  return {
    pageIndex,
    rect: {
      x: Math.max(0, physical.x - 3),
      y: Math.max(0, physical.y - 1),
      w: physical.w + 6,
      h: physical.h + 3,
    },
    preserveRects: characters.map((character) => ({
      x: Math.max(0, character.rect.x - 0.5),
      y: Math.max(0, character.rect.y - 0.5),
      w: character.rect.w + 1,
      h: character.rect.h + 1,
    })),
    sourceRanges: ranges.map((range) => ({ start: range.start, end: range.end })),
    hint: ranges.map((range) => range.text).join(' '),
  };
}

function isStandaloneFormulaParagraph(
  unit: SemanticUnit,
  block: Doc['blocks'][number] | undefined,
): boolean {
  if (unit.kind !== 'paragraph' || !block || !unit.sourceText) return false;
  const source = unit.sourceText.trim();
  if (!source || source.length > 80 || block.rect.h > 72) return false;
  const naturalWords = source.match(/[A-Za-z]{3,}/g) ?? [];
  const strongMath = /[=+−∑∏∫√≤≥≈≠⟨⟩λ𝐀-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(source);
  const formulaCharacters = source.match(/[\d=+−∑∏∫√≤≥≈≠⟨⟩λ𝐀-𝑧𝛼-𝜔α-ωΑ-Ω]/gu)?.length ?? 0;
  return naturalWords.length === 0 && strongMath && formulaCharacters >= 2;
}

interface InlineFormulaFragment {
  start: number;
  end: number;
  before: string;
  after: string;
  pageIndex: number;
  rect: Rect;
}

function inlineFormulaFragment(
  block: Doc['blocks'][number],
  source: string,
): InlineFormulaFragment | undefined {
  if (!block.characterRects?.length) return undefined;
  const leadingLines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (
    leadingLines.length >= 3
    && /[=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(leadingLines[0]!)
    && /^\(\s*\d+[a-z]?\s*\)$/i.test(leadingLines[1]!)
  ) return undefined;
  const equalsIndex = source.indexOf('=');
  if (equalsIndex < 1) return undefined;
  const left = source.slice(0, equalsIndex).match(
    /\b([A-Za-z](?:\s+[A-Za-z]){1,2}|[A-Za-z][A-Za-z0-9_]*(?:\s*[′'])?(?:\s+def)?(?:\s+[23])?)\s*$/,
  );
  if (!left?.index && left?.index !== 0) return undefined;
  const formulaStart = left.index;
  const delimiter = source.slice(equalsIndex + 1).match(
    /\s*(?:[,;]\s*(?=(?:where|with|which|for|respectively|and)\b)|(?=(?:where|with|which|whose|into|from|using|through|under|over|is|are|was|were|can|could|will|would|shall|should|may|might|must|represents?|denotes?|equals?)\b)|[.]\s*(?=[A-Z]|$)|$)/,
  );
  if (!delimiter?.index && delimiter?.index !== 0) return undefined;
  const formulaEnd = equalsIndex + 1 + delimiter.index;
  const formulaText = source.slice(formulaStart, formulaEnd).trim();
  if (formulaText.length < 5 || formulaText.length > 100) return undefined;
  const rawFormula = source.slice(formulaStart, formulaEnd);
  const leadingWhitespace = rawFormula.length - rawFormula.trimStart().length;
  const formulaSourceStart = formulaStart + leadingWhitespace;
  const formulaSourceText = rawFormula.trim();
  const sourceOffset = (block.text ?? '').indexOf(source);
  // Source cleaners can remove scattered PDF fragments before this pass. In
  // that case the whole cleaned paragraph no longer has a direct offset in the
  // raw block, while the mathematical substring itself still does. Resolve the
  // exact formula against raw text as a guarded fallback so its character
  // geometry remains usable after cleaning.
  const absoluteFormulaStart = sourceOffset >= 0
    ? sourceOffset + formulaSourceStart
    : (block.text ?? '').indexOf(formulaSourceText);
  if (absoluteFormulaStart < 0) return undefined;
  const absoluteFormulaEnd = absoluteFormulaStart + formulaSourceText.length;
  const characters = block.characterRects.filter((character) => (
    character.sourceIndex >= absoluteFormulaStart
    && character.sourceIndex < absoluteFormulaEnd
    && character.ch.trim().length > 0
  ));
  const physical = unionRects(characters.map((character) => character.rect));
  if (!physical) return undefined;
  const page = characters[0]?.pageIndex;
  if (page === undefined || characters.some((character) => character.pageIndex !== page)) return undefined;
  const physicalBottom = physical.y + physical.h;
  const nextLineTop = Math.min(
    ...(block.characterRects ?? [])
      .filter((character) => (
        character.pageIndex === page
        && character.sourceIndex >= absoluteFormulaEnd
        && character.ch.trim().length > 0
        && character.rect.y >= physicalBottom + 0.5
        && character.rect.x < physical.x + physical.w + 3
        && character.rect.x + character.rect.w > physical.x - 3
      ))
      .map((character) => character.rect.y),
  );
  const bottomPad = Number.isFinite(nextLineTop)
    ? Math.max(0, Math.min(7, nextLineTop - physicalBottom - 1))
    : 7;
  return {
    start: formulaStart,
    end: formulaEnd,
    before: source.slice(0, formulaStart).trim().replace(/[,;:]\s*$/, ''),
    after: source.slice(formulaEnd).trim().replace(/^[,;:]\s*/, ''),
    pageIndex: page,
    // Subscripts and large operators can be assigned to a neighbouring PDF
    // text block even when their visible ink belongs to this equation line.
    // Do not add an upper pad: the preceding prose baseline is often only one
    // line above and even two PDF points can capture its descenders. Detached
    // limits are recovered precisely from nearby formula-only blocks below.
    rect: {
      x: Math.max(0, physical.x - 3),
      y: Math.max(0, physical.y),
      w: physical.w + 6,
      h: physical.h + bottomPad,
    },
  };
}

function absorbDetachedFormulaGlyphs(
  asset: DetectedAssetRegion,
  siblingAssets: readonly DetectedAssetRegion[],
  fragmentGlyphs: readonly CharacterRect[],
  page: Doc['pages'][number],
): void {
  if (asset.geometrySource === 'font-runs') return;
  const glyphRows: CharacterRect[][] = [];
  for (const character of fragmentGlyphs
    .filter((candidate) => candidate.pageIndex === asset.pageIndex && candidate.ch.trim())
    .sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x)) {
    const row = glyphRows.find((candidate) => (
      candidate.length > 0 && Math.abs(candidate[0]!.rect.y - character.rect.y) <= 1.5
    ));
    if (row) row.push(character);
    else glyphRows.push([character]);
  }
  const proximity = (rect: Rect, candidate: DetectedAssetRegion): {
    horizontalGap: number; verticalGap: number; score: number;
  } => {
    const horizontalGap = Math.max(
      0,
      rect.x - (candidate.rect.x + candidate.rect.w),
      candidate.rect.x - (rect.x + rect.w),
    );
    const verticalGap = Math.max(
      0,
      rect.y - (candidate.rect.y + candidate.rect.h),
      candidate.rect.y - (rect.y + rect.h),
    );
    const centerDistance = Math.abs(
      rect.y + rect.h / 2 - (candidate.rect.y + candidate.rect.h / 2),
    );
    return { horizontalGap, verticalGap, score: verticalGap * 100 + centerDistance + horizontalGap };
  };
  const nearbyGlyphs = glyphRows.flatMap((row) => {
    const rowRect = unionRects(row.map((character) => character.rect));
    if (!rowRect) return [];
    const current = proximity(rowRect, asset);
    if (current.horizontalGap > 8 || current.verticalGap > 8) return [];
    const closest = siblingAssets
      .filter((candidate) => candidate.pageIndex === asset.pageIndex)
      .map((candidate) => ({ candidate, ...proximity(rowRect, candidate) }))
      .sort((left, right) => left.score - right.score || left.candidate.id.localeCompare(right.candidate.id))[0];
    // PDF.js often emits `j + u - 1` as one detached row. Once that row is
    // assigned to this formula, preserve the entire row instead of stopping
    // after the first individually-near glyph and cutting off its tail.
    return closest?.candidate.id === asset.id ? row : [];
  });
  if (!nearbyGlyphs.length) return;
  const existingPreserveRects = asset.preserveRects?.length
    ? [...asset.preserveRects]
    : [{ ...asset.rect }];
  const combined = nearbyGlyphs.reduce(
    (rect, character) => unionRect(rect, character.rect),
    { ...asset.rect },
  );
  const x = Math.max(0, combined.x - 1);
  const y = Math.max(0, combined.y - 0.5);
  const right = Math.min(page.width, combined.x + combined.w + 1);
  // Keep half a point of vertical raster safety. A full point can touch the
  // following prose baseline in tightly led two-column papers.
  const bottom = Math.min(page.height, combined.y + combined.h + 0.5);
  asset.rect = { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
  asset.preserveRects = [
    ...existingPreserveRects,
    ...nearbyGlyphs.map((character) => ({
      x: Math.max(0, character.rect.x - 0.5),
      y: Math.max(0, character.rect.y - 0.5),
      w: character.rect.w + 1,
      h: character.rect.h + 1,
    })),
  ];
  asset.requiresLargeOperator ||= nearbyGlyphs.some((character) => /[∑∏∫]/u.test(character.ch));
}

function detachedFormulaGlyphs(
  block: Doc['blocks'][number],
  pageIndex: number,
): CharacterRect[] {
  if (!block.characterRects?.length || block.pageIndex !== pageIndex) return [];
  const source = block.text ?? '';
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const line of source.split(/\r?\n/)) {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 100) continue;
    const naturalWords = trimmed.match(/[A-Za-z]{3,}/g)?.length ?? 0;
    const strongMath = /[=+\-*/∑∏∫√≤≥≈≠⌈⌉→←↦λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(trimmed);
    const compactMathTokens = naturalWords === 0
      && /^[\s\dA-Za-z.,()[\]{}|^ˆ′'_=+\-*/∑∏∫√≤≥≈≠⌈⌉→←↦λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]+$/u.test(trimmed);
    if (naturalWords <= 2 && (strongMath || compactMathTokens)) ranges.push({ start, end });
  }
  return block.characterRects.filter((character) => (
    character.pageIndex === pageIndex
    && character.ch.trim()
    && ranges.some((range) => character.sourceIndex >= range.start && character.sourceIndex < range.end)
  ));
}

function normalizePdfNumericSpacing(source: string, allowSingleSmallCaps = false): string {
  const normalized = source
    // Symbol-font vector accents can surface as C0 control codes (notably
    // U+0003) in PDF.js text. They cannot be rendered by Typst and otherwise
    // become visible replacement squares. The surrounding variable and
    // subscript remain readable; immutable source pixels retain decoration.
    // PDF.js can expose C0 controls from embedded symbol fonts. These code
    // points are intentionally matched and removed before Typst rendering.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // PDF.js may emit a decimal point and its digits as separate glyph runs.
    // Canonicalizing only digit-surrounded punctuation keeps prose and formula
    // punctuation intact while preventing `2 . 08` from becoming four
    // independent protected tokens that are later appended to `2.08`.
    .replace(/(?<=\d)\s*[.]\s*(?=\d)/g, '.')
    .replace(/(?<=\d)\s*([%‰×])\s*/g, '$1')
    // Preserve hyphenated technical identifiers across a visual PDF line
    // wrap. Otherwise `MNT4-\n753` becomes two protected-number contexts and
    // a model that correctly emits `MNT4-753` can be "repaired" with a second
    // stray 753 at the end of the sentence.
    .replace(/\b([A-Za-z]+\d*)-[ \t]*\r?\n[ \t]*(\d+)\b/g, '$1-$2');
  return normalized.split(/\r?\n/).map((line) => {
    const splitSmallCaps = line.match(/\b[A-Z]\s+[A-Z]{2,}\b/g) ?? [];
    if (splitSmallCaps.length < (allowSingleSmallCaps ? 1 : 2)) return line;
    // Small-caps fonts are often extracted as `P ERFORMANCE C OMPARISON`.
    // Require two such words on the same line so normal phrases like `A FPGA`
    // are not collapsed into a false identifier.
    return line.replace(/\b([A-Z])\s+([A-Z]{2,})\b/g, '$1$2');
  }).join('\n');
}

const MAX_TRANSLATION_UNIT_CHARACTERS = 1_800;

function splitOversizedSourceText(source: string): string[] {
  const parts: string[] = [];
  let remaining = source.trim();
  while (remaining.length > MAX_TRANSLATION_UNIT_CHARACTERS) {
    const window = remaining.slice(0, MAX_TRANSLATION_UNIT_CHARACTERS + 1);
    let cut = -1;
    // A single PDF newline is normally only a visual line wrap. Treating it as
    // a semantic boundary can leave a request ending in fragments such as
    // "our scheme has a", which invites the model to complete text belonging
    // to the next request and duplicates the following sentence.
    const boundary = /(?:[.!?。！？](?:["')\]]*)\s+|\n{2,})/g;
    for (const match of window.matchAll(boundary)) {
      const end = (match.index ?? 0) + match[0].length;
      if (end >= MAX_TRANSLATION_UNIT_CHARACTERS * 0.5) cut = end;
    }
    if (cut < 0) cut = window.lastIndexOf(' ', MAX_TRANSLATION_UNIT_CHARACTERS);
    if (cut < MAX_TRANSLATION_UNIT_CHARACTERS * 0.5) cut = MAX_TRANSLATION_UNIT_CHARACTERS;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function withoutTrailingVisualPunctuationRows(source: string): string {
  const lines = source.split(/\r?\n/);
  let cut = lines.length;
  while (cut > 1) {
    const line = lines[cut - 1]!.trim();
    if (!line || /[\p{L}\p{N}]/u.test(line) || !/^[\p{P}\p{S}\s]+$/u.test(line)) break;
    cut -= 1;
  }
  return lines.slice(0, cut).join('\n').trim();
}

function normalizedPrefixEnd(source: string, prefix: string): number | undefined {
  let sourceIndex = 0;
  let prefixIndex = 0;
  while (prefixIndex < prefix.length) {
    while (sourceIndex < source.length && /\s/u.test(source[sourceIndex]!)) sourceIndex += 1;
    while (prefixIndex < prefix.length && /\s/u.test(prefix[prefixIndex]!)) prefixIndex += 1;
    if (prefixIndex >= prefix.length) return sourceIndex;
    if (sourceIndex >= source.length) return undefined;
    if (source[sourceIndex]!.normalize('NFKC') !== prefix[prefixIndex]!.normalize('NFKC')) return undefined;
    sourceIndex += 1;
    prefixIndex += 1;
  }
  return sourceIndex;
}

/**
 * A parser aggregate can end with the beginning of a sentence followed by a
 * figure's internal labels, while the lowercase continuation is emitted after
 * the figure caption on the next page/column. Rejoin only the first complete
 * continuation sentence. The rest of the following paragraph stays after the
 * figure, and sourceBlockId remains anchored to the prefix block so alignment
 * can resolve the sentence across both original PDF blocks.
 */
function repairInterruptedProseAcrossImmutableAsset(
  inputUnits: SemanticUnit[],
  regions: LayoutRegion[],
  assets: readonly DetectedAssetRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): SemanticUnit[] {
  const proseKinds = new Set<SemanticUnitKind>(['paragraph', 'abstract', 'list-item']);
  const ordered = [...inputUnits].sort((left, right) => left.order - right.order);
  const removedIds = new Set<string>();

  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    if (removedIds.has(current.id) || !proseKinds.has(current.kind) || !current.sourceText) continue;
    const cleanedCurrent = withoutTrailingVisualPunctuationRows(current.sourceText);
    if (
      /[.!?。！？]["')\]}”’]*\s*$/u.test(cleanedCurrent)
      || (cleanedCurrent.match(/[A-Za-z]{2,}/g)?.length ?? 0) < 4
    ) continue;

    const nextIndex = ordered.findIndex((candidate, candidateIndex) => (
      candidateIndex > index
      && !removedIds.has(candidate.id)
      && proseKinds.has(candidate.kind)
      && Boolean(candidate.sourceText?.trim())
    ));
    if (nextIndex < 0) continue;
    const next = ordered[nextIndex]!;
    const nextSource = next.sourceText!.trim();
    if (!/^[\s([{'"“‘]*\p{Ll}/u.test(nextSource)) continue;

    const between = ordered.slice(index + 1, nextIndex).filter((unit) => !removedIds.has(unit.id));
    if (between.some((unit) => ![
      'figure', 'table', 'formula', 'code', 'caption', 'table-title', 'page-furniture',
    ].includes(unit.kind))) continue;
    const captionedVisuals = between.flatMap((unit) => {
      if (!['figure', 'table', 'code'].includes(unit.kind)) return [];
      const asset = assets.find((candidate) => candidate.id === (unit.assetId ?? unit.id));
      return asset?.captionUnitId && between.some((candidate) => candidate.id === asset.captionUnitId)
        ? [asset]
        : [];
    });
    const currentBlock = blocks.get(current.sourceBlockId ?? current.id);
    const nextBlock = blocks.get(next.sourceBlockId ?? next.id);
    if (!currentBlock || !nextBlock) continue;
    const physicallyInterposedVisual = assets.some((asset) => {
      if (
        !asset.captionUnitId
        || nextBlock.pageIndex <= currentBlock.pageIndex
        || asset.pageIndex !== nextBlock.pageIndex
      ) return false;
      const captionBlock = blocks.get(asset.captionUnitId);
      const visualBottom = Math.max(
        asset.rect.y + asset.rect.h,
        captionBlock && captionBlock.pageIndex === asset.pageIndex
          ? captionBlock.rect.y + captionBlock.rect.h
          : 0,
      );
      return visualBottom <= nextBlock.rect.y + 4;
    });
    if (!captionedVisuals.length && !physicallyInterposedVisual) continue;
    const currentPages = physicalPages(currentBlock);
    const lastCurrentPage = Math.max(...currentPages);
    if (
      nextBlock.pageIndex < currentBlock.pageIndex
      || nextBlock.pageIndex > lastCurrentPage + 1
      || (
        !physicallyInterposedVisual
        && !captionedVisuals.some((asset) => (
          asset.pageIndex >= currentBlock.pageIndex && asset.pageIndex <= nextBlock.pageIndex
        ))
      )
    ) continue;

    const candidates = buildSourceSentenceCandidates(next.id, nextSource);
    if (candidates.mode !== 'sentence-candidates') continue;
    const firstSentence = candidates.sentences[0]?.text.trim();
    if (
      !firstSentence
      || firstSentence.length > 800
      || !/[.!?。！？]["')\]}”’]*$/u.test(firstSentence)
    ) continue;
    const prefixEnd = normalizedPrefixEnd(nextSource, firstSentence);
    if (prefixEnd === undefined) continue;

    current.sourceText = `${cleanedCurrent}\n${firstSentence}`;
    current.protectedTokens = extractProtectedTokens(current.sourceText);
    current.sourceBlockIds = [...new Set([
      ...(current.sourceBlockIds ?? [current.sourceBlockId ?? current.id]),
      next.sourceBlockId ?? next.id,
    ])];
    const remainder = nextSource.slice(prefixEnd).trim();
    if (remainder) {
      next.sourceText = remainder;
      next.protectedTokens = extractProtectedTokens(remainder);
    } else {
      removedIds.add(next.id);
    }
  }

  if (!removedIds.size) return inputUnits;
  for (const region of regions) {
    region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !removedIds.has(unitId));
  }
  return inputUnits.filter((unit) => !removedIds.has(unit.id));
}

function recoverOperatorInlineFormulas(
  doc: Doc,
  units: SemanticUnit[],
  regions: LayoutRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
  assetRegions: DetectedAssetRegion[],
  measuredFormulas: readonly DetectedAssetRegion[] = [],
): void {
  for (const unit of [...units]) {
    if (!unit.sourceText || !['paragraph', 'abstract', 'list-item'].includes(unit.kind)) continue;
    const block = blocks.get(unit.sourceBlockId ?? unit.id);
    if (!block || assetRegions.some((asset) => asset.id.startsWith(`${unit.id}-inline-operator-formula`))) continue;
    const operators = (block.characterRects ?? []).filter((character) => /[∑∏∫]/u.test(character.ch));
    if (operators.length && operators.every((character) => measuredFormulas.some((formula) => (
      formula.sourceCharacterRanges?.some((range) => range.blockId === block.id
        && character.sourceIndex >= range.start && character.sourceIndex < range.end)
    )))) continue;
    const geometry = operatorInlineFormulaGeometry(block);
    const page = geometry ? doc.pages[geometry.pageIndex] : undefined;
    if (!geometry || !page || geometry.rect.w > page.width * 0.55 || geometry.rect.h > 72) continue;

    const assetId = `${unit.id}-inline-operator-formula`;
    const asset: DetectedAssetRegion = {
      id: assetId,
      kind: 'formula',
      pageIndex: geometry.pageIndex,
      rect: geometry.rect,
      widthMode: block.widthMode,
      preserveRects: geometry.preserveRects,
      sourceCharacterRanges: geometry.sourceRanges.map((range) => ({
        blockId: block.id,
        start: range.start,
        end: range.end,
      })),
      formulaHint: geometry.hint,
      requiresLargeOperator: true,
    };
    const formulaUnit: SemanticUnit = {
      ...unit,
      id: assetId,
      kind: 'formula',
      sourceText: undefined,
      protectedTokens: [],
      assetId,
      sourceBlockId: block.id,
      order: unit.order - 0.0001,
    };
    const unitIndex = units.indexOf(unit);
    units.splice(unitIndex, 0, formulaUnit);
    const region = regions.find((candidate) => candidate.id === unit.layoutRegionId);
    const regionIndex = region?.orderedUnitIds.indexOf(unit.id) ?? -1;
    if (region && regionIndex >= 0) region.orderedUnitIds.splice(regionIndex, 0, formulaUnit.id);
    assetRegions.push(asset);

    // Limits and subscripts can be emitted into a neighbouring narrow text
    // block. Add only math-only glyph rows that are physically close to the
    // recovered operator, and remove their duplicate standalone digit lines
    // from prose after the pixels have been retained.
    for (const siblingUnit of units) {
      if (!siblingUnit.sourceText || siblingUnit.id === unit.id || siblingUnit.id === formulaUnit.id) continue;
      const siblingBlock = blocks.get(siblingUnit.sourceBlockId ?? siblingUnit.id);
      if (!siblingBlock || siblingBlock.pageIndex !== geometry.pageIndex) continue;
      const horizontalGap = Math.max(
        0,
        siblingBlock.rect.x - (asset.rect.x + asset.rect.w),
        asset.rect.x - (siblingBlock.rect.x + siblingBlock.rect.w),
      );
      const verticalGap = Math.max(
        0,
        siblingBlock.rect.y - (asset.rect.y + asset.rect.h),
        asset.rect.y - (siblingBlock.rect.y + siblingBlock.rect.h),
      );
      if (horizontalGap > 24 || verticalGap > 18) continue;
      const glyphs = detachedFormulaGlyphs(siblingBlock, geometry.pageIndex);
      if (!glyphs.length) continue;
      absorbDetachedFormulaGlyphs(asset, [asset], glyphs, page);
      // Being near an operator is insufficient: the expansion can reject a
      // neighbouring subscript. Remove text only when its ink was retained.
      if (!glyphs.every((character) => assetCompositesSourceCharacter(asset, siblingBlock, character))) continue;
      const cleaned = siblingUnit.sourceText
        .split(/\r?\n/)
        .filter((line) => !/^\s*\d+\s*$/.test(line))
        .join('\n')
        .trim();
      if (cleaned !== siblingUnit.sourceText) {
        siblingUnit.sourceText = cleaned;
        siblingUnit.protectedTokens = extractProtectedTokens(cleaned);
      }
    }
  }
}

/**
 * A single-column page can still contain narrow inline-formula fragments.
 * Parser column ranking places those fragments after the enclosing full-width
 * paragraph, even though their physical row sits before that paragraph's last
 * line. Split only the trailing line and place it after the nested band.
 */
function repairNestedInlineReadingOrder(
  doc: Doc,
  units: SemanticUnit[],
  regions: LayoutRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): void {
  for (const container of [...units]) {
    if (!container.sourceText || !['paragraph', 'abstract', 'list-item'].includes(container.kind)) continue;
    const block = blocks.get(container.sourceBlockId ?? container.id);
    const page = block ? doc.pages[block.pageIndex] : undefined;
    if (!block || !page || block.rect.w < page.width * 0.55 || block.rect.h < 72) continue;
    const lines = container.sourceText.split(/\r?\n/);
    const trailingLine = lines.at(-1)?.trim() ?? '';
    const precedingLine = lines.at(-2)?.trim() ?? '';
    if (
      lines.length < 3
      || !/^\p{Ll}/u.test(trailingLine)
      || (trailingLine.match(/[A-Za-z]{3,}/g)?.length ?? 0) < 5
      || /[.!?。！？]["')\]}”’]*\s*$/u.test(precedingLine)
    ) continue;

    const nestedBlocks = doc.blocks.filter((candidate) => {
      if (candidate.id === block.id || candidate.pageIndex !== block.pageIndex) return false;
      if (candidate.rect.w > block.rect.w * 0.75 || candidate.rect.h > 72) return false;
      const coverage = intersectionArea(candidate.rect, block.rect)
        / Math.max(1, candidate.rect.w * candidate.rect.h);
      return coverage >= 0.75
        && candidate.rect.y >= block.rect.y + block.rect.h * 0.55;
    });
    if (nestedBlocks.length < 2 || !nestedBlocks.some((candidate) => /[∑∏∫]/u.test(candidate.text ?? ''))) {
      continue;
    }
    const nestedBand = unionRects(nestedBlocks.map((candidate) => candidate.rect));
    if (!nestedBand || nestedBand.w < block.rect.w * 0.72) continue;
    const nestedIds = new Set(nestedBlocks.map((candidate) => candidate.id));
    const nestedUnits = units.filter((candidate) => (
      nestedIds.has(candidate.sourceBlockId ?? candidate.id)
      && candidate.id !== container.id
    ));
    if (nestedUnits.length < 2) continue;
    const targetRegion = regions.find((region) => (
      nestedUnits.some((candidate) => candidate.layoutRegionId === region.id)
    ));
    if (!targetRegion) continue;

    let prefix = lines.slice(0, -1).join('\n').trim();
    if (!prefix || units.some((candidate) => candidate.id === `${container.id}-nested-tail`)) continue;

    // In a two-lane extraction the final words of the left lane can be emitted
    // as a narrow nested block beside the right-lane formula. Translate that
    // continuation together with its unfinished prefix; sending either half to
    // the model independently produces fluent but semantically incomplete text.
    const firstOperatorX = Math.min(
      ...nestedBlocks.filter((candidate) => /[∑∏∫]/u.test(candidate.text ?? ''))
        .map((candidate) => candidate.rect.x),
    );
    const leadingContinuation = nestedUnits
      .map((candidate) => ({
        unit: candidate,
        block: blocks.get(candidate.sourceBlockId ?? candidate.id),
      }))
      .filter((candidate): candidate is { unit: SemanticUnit; block: Doc['blocks'][number] } => (
        Boolean(candidate.block)
        && ['paragraph', 'abstract', 'list-item'].includes(candidate.unit.kind)
        && Boolean(candidate.unit.sourceText)
        && /^[\s([{'"“‘]*\p{Ll}/u.test(candidate.unit.sourceText!)
        && (candidate.unit.sourceText!.match(/[A-Za-z]{3,}/g)?.length ?? 0) >= 4
        && candidate.block!.rect.x + candidate.block!.rect.w <= firstOperatorX + 12
      ))
      .sort((left, right) => left.block.rect.x - right.block.rect.x || left.unit.order - right.unit.order)[0];
    if (
      leadingContinuation
      && !/[.!?。！？]["')\]}”’]*\s*$/u.test(prefix)
    ) {
      prefix = `${prefix}\n${leadingContinuation.unit.sourceText!.trim()}`;
      const continuationId = leadingContinuation.unit.id;
      const continuationIndex = units.findIndex((candidate) => candidate.id === continuationId);
      if (continuationIndex >= 0) units.splice(continuationIndex, 1);
      for (const region of regions) {
        region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => unitId !== continuationId);
      }
    }

    container.sourceText = prefix;
    container.protectedTokens = extractProtectedTokens(prefix);
    const tail: SemanticUnit = {
      ...container,
      id: `${container.id}-nested-tail`,
      parentId: container.id,
      sourceBlockId: block.id,
      sourceText: trailingLine,
      protectedTokens: extractProtectedTokens(trailingLine),
      layoutRegionId: targetRegion.id,
      order: Math.max(...nestedUnits.map((candidate) => candidate.order)) + 0.0005,
    };
    units.push(tail);
    const nestedRegionIndexes = targetRegion.orderedUnitIds
      .map((unitId, index) => ({ unitId, index }))
      .filter(({ unitId }) => {
        const candidate = units.find((unit) => unit.id === unitId);
        return candidate ? nestedIds.has(candidate.sourceBlockId ?? candidate.id) : false;
      })
      .map(({ index }) => index);
    const insertAt = nestedRegionIndexes.length ? Math.max(...nestedRegionIndexes) + 1 : targetRegion.orderedUnitIds.length;
    targetRegion.orderedUnitIds.splice(insertAt, 0, tail.id);
  }
}

/** Join a wrapped table caption line that sits physically between its caption and table. */
function repairCaptionContinuationBeforeImmutableTable(
  inputUnits: SemanticUnit[],
  regions: LayoutRegion[],
  assets: readonly DetectedAssetRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): SemanticUnit[] {
  const removedIds = new Set<string>();
  for (const asset of assets) {
    if (asset.kind !== 'table' || !asset.captionUnitId) continue;
    const caption = inputUnits.find((unit) => unit.id === asset.captionUnitId);
    const captionBlock = blocks.get(asset.captionUnitId);
    if (
      !caption?.sourceText
      || !captionBlock
      || /[.!?。！？]["')\]}”’]*\s*$/u.test(caption.sourceText)
    ) continue;
    const captionBottom = captionBlock.rect.y + captionBlock.rect.h;
    const continuation = inputUnits
      .filter((unit) => (
        !removedIds.has(unit.id)
        && unit.kind === 'paragraph'
        && unit.order > caption.order
        && Boolean(unit.sourceText?.trim())
      ))
      .map((unit) => ({ unit, block: blocks.get(unit.sourceBlockId ?? unit.id) }))
      .filter((candidate): candidate is { unit: SemanticUnit; block: Doc['blocks'][number] } => {
        if (!candidate.block || candidate.block.pageIndex !== asset.pageIndex) return false;
        const horizontalOverlap = Math.max(0, Math.min(
          captionBlock.rect.x + captionBlock.rect.w,
          candidate.block.rect.x + candidate.block.rect.w,
        ) - Math.max(captionBlock.rect.x, candidate.block.rect.x));
        const source = candidate.unit.sourceText!.trim();
        // A Vision table crop often begins through the glyph box of a wrapped
        // caption's final line. PDF.js reports the full font box, while the
        // visible baseline can still lie inside the crop by almost one line
        // height. Accept that one shallow overlap; the lowercase prose and
        // caption-gap guards below prevent a table header from being consumed.
        const topEdgeTolerance = Math.max(5, Math.min(14, candidate.block.rect.h));
        return candidate.block.rect.y >= captionBottom - 2
          && candidate.block.rect.y - captionBottom <= 24
          // Vision crops can start through the baseline of the final caption
          // line. Accept at most one shallow text-line overlap, then move the
          // immutable crop below the recovered continuation.
          && candidate.block.rect.y + candidate.block.rect.h <= asset.rect.y + topEdgeTolerance
          && horizontalOverlap >= Math.min(captionBlock.rect.w, candidate.block.rect.w) * 0.45
          && /^[\s([{'"“‘]*\p{Ll}/u.test(source)
          && (source.match(/[A-Za-z]{2,}/g)?.length ?? 0) >= 3
          && source.length <= 180;
      })
      .sort((left, right) => left.block.rect.y - right.block.rect.y || left.unit.order - right.unit.order)[0];
    if (!continuation) continue;
    caption.sourceText = appendCaptionContinuation(
      caption.sourceText.trim(),
      continuation.unit.sourceText!.trim(),
    );
    caption.protectedTokens = extractProtectedTokens(caption.sourceText);
    removedIds.add(continuation.unit.id);
    const assetBottom = asset.rect.y + asset.rect.h;
    const recoveredBottom = continuation.block.rect.y + continuation.block.rect.h + 2;
    const nextTop = Math.max(asset.rect.y, recoveredBottom);
    if (nextTop < assetBottom - 12) {
      asset.rect = { ...asset.rect, y: nextTop, h: assetBottom - nextTop };
    }
  }
  if (!removedIds.size) return inputUnits;
  for (const region of regions) {
    region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !removedIds.has(unitId));
  }
  return inputUnits.filter((unit) => !removedIds.has(unit.id));
}

function repairAssetsBeforeBibliography(
  units: SemanticUnit[],
  regions: LayoutRegion[],
  assets: readonly DetectedAssetRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): void {
  const headings = units.filter((unit) => unit.kind === 'heading' && isBibliographyHeading(unit.sourceText));
  for (const heading of headings) {
    const headingBlock = blocks.get(heading.sourceBlockId ?? heading.id);
    const targetRegion = regions.find((region) => region.orderedUnitIds.includes(heading.id));
    if (!headingBlock || !targetRegion) continue;
    const precedingAssets = assets
      .map((asset) => ({
        asset,
        caption: asset.captionUnitId ? units.find((unit) => unit.id === asset.captionUnitId) : undefined,
        captionBlock: asset.captionUnitId ? blocks.get(asset.captionUnitId) : undefined,
      }))
      .filter((candidate) => (
        candidate.asset.pageIndex === headingBlock.pageIndex
        && (candidate.caption?.layoutRegionId === targetRegion.id
          || units.find((unit) => unit.id === candidate.asset.id)?.layoutRegionId === targetRegion.id)
        && candidate.asset.rect.y + candidate.asset.rect.h <= headingBlock.rect.y + 2
        && (!candidate.captionBlock || candidate.captionBlock.rect.y < headingBlock.rect.y)
      ))
      .sort((left, right) => left.asset.rect.y - right.asset.rect.y || left.asset.rect.x - right.asset.rect.x);
    if (!precedingAssets.length) continue;
    const movingIds = new Set(precedingAssets.flatMap(({ asset, caption }) => (
      [caption?.id, asset.id].filter((id): id is string => Boolean(id))
    )));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !movingIds.has(unitId));
    }
    const orderedIds = precedingAssets.flatMap(({ asset, caption }) => (
      asset.kind === 'figure'
        ? [asset.id, caption?.id].filter((id): id is string => Boolean(id))
        : [caption?.id, asset.id].filter((id): id is string => Boolean(id))
    ));
    const headingIndex = Math.max(0, targetRegion.orderedUnitIds.indexOf(heading.id));
    targetRegion.orderedUnitIds.splice(headingIndex, 0, ...orderedIds);
    orderedIds.forEach((unitId, index) => {
      const unit = units.find((candidate) => candidate.id === unitId);
      if (!unit) return;
      unit.layoutRegionId = targetRegion.id;
      unit.order = heading.order - (orderedIds.length - index) / 1_000;
    });
  }
}

function trailingFormulaRect(
  block: Doc['blocks'][number],
  cleanedLength: number,
): Doc['blocks'][number]['rect'] | undefined {
  const characters = (block.characterRects ?? []).filter((character) => (
    character.pageIndex === block.pageIndex
    && character.sourceIndex >= cleanedLength
    && /[\d=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(character.ch)
  ));
  if (!characters.length) return undefined;
  const x = Math.min(...characters.map((character) => character.rect.x));
  const y = Math.min(...characters.map((character) => character.rect.y));
  const right = Math.max(...characters.map((character) => character.rect.x + character.rect.w));
  const bottom = Math.max(...characters.map((character) => character.rect.y + character.rect.h));
  return { x: x - 2, y: y - 2, w: right - x + 4, h: bottom - y + 4 };
}

function visualColumn(block: Doc['blocks'][number], pageWidth: number): 'span' | 'left' | 'right' {
  if (block.widthMode === 'span') return 'span';
  return block.rect.x + block.rect.w / 2 < pageWidth / 2 ? 'left' : 'right';
}

function sameVisualColumn(
  left: Doc['blocks'][number],
  right: Doc['blocks'][number],
  pageWidth: number,
): boolean {
  return visualColumn(left, pageWidth) === visualColumn(right, pageWidth);
}

interface RecoveredCaptionLane {
  anchor: Doc['blocks'][number];
  sourceText: string;
  continuationIds: string[];
}

function appendCaptionContinuation(source: string, continuation: string): string {
  if (source.endsWith('-') && /^[a-z]/.test(continuation)) {
    return `${source.slice(0, -1)}${continuation}`;
  }
  return `${source} ${continuation}`;
}

/**
 * Some two-column PDFs emit the left caption and the right prose baseline as
 * one span block. A narrow continuation directly below the caption is strong
 * physical evidence that the real caption belongs to only one column.
 */
function recoverSplitColumnCaption(
  doc: Doc,
  caption: Doc['blocks'][number],
): RecoveredCaptionLane | undefined {
  const page = doc.pages[caption.pageIndex];
  if (!page || caption.widthMode !== 'span' || caption.rect.w < page.width * 0.65) return undefined;
  const firstCharacter = (caption.characterRects ?? [])
    .filter((character) => character.pageIndex === caption.pageIndex && character.ch.trim())
    .sort((left, right) => left.sourceIndex - right.sourceIndex)[0];
  const captionOnLeft = (firstCharacter?.rect.x ?? caption.rect.x) < page.width / 2;
  const candidates = doc.blocks
    .filter((block) => {
      if (block.id === caption.id || block.pageIndex !== caption.pageIndex) return false;
      const centerX = block.rect.x + block.rect.w / 2;
      const verticalGap = block.rect.y - (caption.rect.y + caption.rect.h);
      return block.rect.w <= page.width * 0.55
        && (centerX < page.width / 2) === captionOnLeft
        && Math.abs(block.rect.x - caption.rect.x) <= page.width * 0.08
        && verticalGap >= -2
        && verticalGap <= 42
        && block.rect.h <= 24
        && Boolean(block.text?.trim());
    })
    .sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x);
  if (!candidates.length) return undefined;

  const continuations: Doc['blocks'] = [];
  let previousBottom = caption.rect.y + caption.rect.h;
  let combinedText = '';
  for (const candidate of candidates) {
    if (candidate.rect.y > previousBottom + 12 || /[.!?]\s*$/.test(combinedText)) break;
    continuations.push(candidate);
    combinedText = appendCaptionContinuation(combinedText, candidate.text!.trim()).trim();
    previousBottom = candidate.rect.y + candidate.rect.h;
  }
  if (!continuations.length) return undefined;

  const laneCharacters = (caption.characterRects ?? []).filter((character) => {
    const centerX = character.rect.x + character.rect.w / 2;
    return character.pageIndex === caption.pageIndex
      && (centerX < page.width / 2) === captionOnLeft
      && character.ch.trim();
  });
  let captionText = caption.text?.trim() ?? '';
  if (laneCharacters.length) {
    const start = Math.min(...laneCharacters.map((character) => character.sourceIndex));
    const end = Math.max(...laneCharacters.map((character) => character.sourceIndex)) + 1;
    const laneText = (caption.text ?? '').slice(start, end).trim();
    if (isFigureCaptionText(laneText) || isTableCaptionText(laneText)) captionText = laneText;
  }
  for (const continuation of continuations) {
    captionText = appendCaptionContinuation(captionText, continuation.text!.trim());
  }

  const laneRects = [
    ...laneCharacters.map((character) => character.rect),
    ...continuations.map((block) => block.rect),
  ];
  const lane = unionRects(laneRects);
  if (!lane) return undefined;
  return {
    anchor: {
      ...caption,
      rect: { x: lane.x, y: caption.rect.y, w: lane.w, h: caption.rect.h },
      widthMode: 'column',
    },
    sourceText: captionText.replace(/\s+/g, ' ').trim(),
    continuationIds: continuations.map((block) => block.id),
  };
}

/** Rejoin a caption continuation that PDF.js emitted as the next column block. */
function recoverColumnCaptionContinuation(
  doc: Doc,
  caption: Doc['blocks'][number],
): RecoveredCaptionLane | undefined {
  const page = doc.pages[caption.pageIndex];
  const source = caption.text?.trim() ?? '';
  if (!page || caption.widthMode !== 'column' || /[.!?]\s*$/.test(source)) return undefined;
  const captionBottom = caption.rect.y + caption.rect.h;
  const continuation = doc.blocks
    .filter((block) => {
      const text = block.text?.trim() ?? '';
      const gap = block.rect.y - captionBottom;
      return block.id !== caption.id
        && block.pageIndex === caption.pageIndex
        && block.type === 'paragraph'
        && sameVisualColumn(block, caption, page.width)
        && Math.abs(block.rect.x - caption.rect.x) <= page.width * 0.04
        && gap >= -1
        && gap <= 7
        && block.rect.h <= 48
        && /^[A-Za-z(]/.test(text);
    })
    .sort((left, right) => left.rect.y - right.rect.y || left.order - right.order)[0];
  if (!continuation) return undefined;
  const lane = unionRects([caption.rect, continuation.rect]);
  if (!lane) return undefined;
  return {
    anchor: {
      ...caption,
      rect: { x: lane.x, y: caption.rect.y, w: lane.w, h: caption.rect.h },
      widthMode: 'column',
    },
    sourceText: appendCaptionContinuation(source, continuation.text!.trim())
      .replace(/\s+/g, ' ').trim(),
    continuationIds: [continuation.id],
  };
}

function previousPhysicalContentBottom(
  doc: Doc,
  caption: Doc['blocks'][number],
): number | undefined {
  const page = doc.pages[caption.pageIndex];
  if (!page) return undefined;
  const captionTop = caption.rect.y;
  const boundaries = doc.blocks.flatMap((block) => {
    if (block.id === caption.id || block.pageIndex !== caption.pageIndex) return [];
    const bottom = block.rect.y + block.rect.h;
    if (bottom > captionTop - 18 || block.rect.y < page.height * 0.08) return [];
    const overlap = Math.max(0, Math.min(
      block.rect.x + block.rect.w,
      caption.rect.x + caption.rect.w,
    ) - Math.max(block.rect.x, caption.rect.x));
    return overlap / Math.max(1, Math.min(block.rect.w, caption.rect.w)) >= 0.25 ? [bottom] : [];
  });
  return boundaries.sort((left, right) => right - left)[0];
}

function previousProseBottomInCaptionColumn(
  doc: Doc,
  caption: Doc['blocks'][number],
): number | undefined {
  const page = doc.pages[caption.pageIndex];
  if (!page) return undefined;
  const captionOnLeft = caption.rect.x + caption.rect.w / 2 < page.width / 2;
  const bottoms: number[] = [];
  for (const block of doc.blocks) {
    if (block.id === caption.id) continue;
    const source = block.text ?? '';
    let offset = 0;
    const lineRecords: Array<{ rect: Rect; natural: boolean }> = [];
    for (const line of source.split(/\r?\n/)) {
      const start = offset;
      const end = start + line.length;
      offset = end + 1;
      const words = line.match(/[A-Za-z]{3,}/g) ?? [];
      const functionWords = line.match(
        /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/gi,
      ) ?? [];
      const lineRect = unionRects((block.characterRects ?? [])
        .filter((character) => {
          const centerX = character.rect.x + character.rect.w / 2;
          return character.pageIndex === caption.pageIndex
            && character.sourceIndex >= start
            && character.sourceIndex < end
            && (centerX < page.width / 2) === captionOnLeft
            && character.ch.trim().length > 0;
        })
        .map((character) => character.rect));
      if (lineRect && lineRect.y + lineRect.h < caption.rect.y - 8) {
        lineRecords.push({ rect: lineRect, natural: words.length >= 8 && functionWords.length >= 2 });
      }
    }
    const sortedLines = lineRecords.sort((left, right) => left.rect.y - right.rect.y);
    const firstNatural = sortedLines.findIndex((line) => line.natural);
    if (firstNatural >= 0) {
      let clusterBottom = sortedLines[firstNatural]!.rect.y + sortedLines[firstNatural]!.rect.h;
      for (const line of sortedLines.slice(firstNatural + 1)) {
        if (line.rect.y > clusterBottom + 18) break;
        clusterBottom = Math.max(clusterBottom, line.rect.y + line.rect.h);
      }
      bottoms.push(clusterBottom);
    }
    if (
      !block.characterRects?.length
      && block.pageIndex === caption.pageIndex
      && sameVisualColumn(block, caption, page.width)
      && block.rect.y + block.rect.h < caption.rect.y - 8
      && (source.match(/[A-Za-z]{3,}/g)?.length ?? 0) >= 8
    ) {
      bottoms.push(block.rect.y + block.rect.h);
    }
  }
  return bottoms.length ? Math.max(...bottoms) : undefined;
}

function looksLikeVisualLabels(block: Doc['blocks'][number]): boolean {
  const lines = (block.text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const labelLike = lines.filter((line) => (
    line.length <= 32 || /^[-+]?\d[\d.,%‰+\- ]*$/.test(line)
  )).length;
  return labelLike / lines.length >= 0.7;
}

function trailingVisualLabelClusterTop(block: Doc['blocks'][number]): number | undefined {
  if (!block.characterRects?.length || !/\r?\n/.test(block.text ?? '')) return undefined;
  let offset = 0;
  const lines = (block.text ?? '').split(/\r?\n/).map((text) => {
    const start = offset;
    const end = start + text.length;
    offset = end + 1;
    const words = text.match(/[A-Za-z]{2,}/g) ?? [];
    const functionWords = text.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|has|have)\b/gi) ?? [];
    const trimmed = text.trim();
    const labelLike = Boolean(trimmed)
      && trimmed.length <= 90
      && words.length <= 10
      && functionWords.length <= 1
      && !/[.!?;:]\s*$/.test(trimmed);
    return { start, end, words: words.length, labelLike };
  });
  let cut = lines.length;
  while (cut > 0 && lines[cut - 1]!.labelLike) cut -= 1;
  if (lines.length - cut < 3 || cut === 0 || !lines.slice(0, cut).some((line) => line.words >= 6)) {
    return undefined;
  }
  const clusterStart = lines[cut]!.start;
  const clusterEnd = lines.at(-1)!.end;
  const characters = block.characterRects.filter((character) => (
    character.sourceIndex >= clusterStart
    && character.sourceIndex < clusterEnd
    && character.ch.trim().length > 0
  ));
  if (!characters.length) return undefined;
  return Math.max(1, Math.min(...characters.map((character) => character.rect.y)) - 6);
}

function extendFigureThroughPrecedingVisualLabels(
  doc: Doc,
  asset: DetectedAssetRegion,
  allAssets: readonly DetectedAssetRegion[],
): void {
  if (asset.kind !== 'figure' || !asset.captionUnitId) return;
  const caption = doc.blocks.find((block) => block.id === asset.captionUnitId);
  if (!caption || embeddedCaptionText(caption.text ?? '', 'figure') !== (caption.text ?? '').trim()) return;
  const pageWidth = doc.pages[asset.pageIndex]?.width ?? doc.meta.paperWidth;
  const protectedTableBlockIds = new Set(doc.blocks
    .filter((block) => allAssets.some((other) => (
      other !== asset
      && other.kind === 'table'
      && other.pageIndex === asset.pageIndex
      && block.rect.x < other.rect.x + other.rect.w
      && block.rect.x + block.rect.w > other.rect.x
      && block.rect.y < other.rect.y + other.rect.h
      && block.rect.y + block.rect.h > other.rect.y
    )))
    .map((block) => block.id));
  const candidates = doc.blocks
    .filter((block) => (
      block.id !== caption.id
      && !protectedTableBlockIds.has(block.id)
      && block.pageIndex === asset.pageIndex
      && sameVisualColumn(block, caption, pageWidth)
      && block.rect.y < caption.rect.y
      && block.rect.y + block.rect.h >= asset.rect.y - 24
    ))
    .flatMap((block) => {
      const top = trailingVisualLabelClusterTop(block);
      return top !== undefined && top < asset.rect.y ? [top] : [];
    });
  if (!candidates.length) return;
  const top = Math.max(...candidates);
  if (asset.rect.y - top > (doc.pages[asset.pageIndex]?.height ?? doc.meta.paperHeight) * 0.25) return;
  const bottom = asset.rect.y + asset.rect.h;
  asset.rect = { ...asset.rect, y: top, h: bottom - top };
}

function looksLikeNumericTableBody(block: Doc['blocks'][number]): boolean {
  const text = block.text ?? '';
  const numericTokens = text.match(/\d+(?:[.,]\d+)?/g)?.length ?? 0;
  const wordTokens = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
  return lines >= 3
    && numericTokens >= 6
    && numericTokens >= Math.max(4, wordTokens * 0.6);
}

function looksLikeShortTableCellText(source: string): boolean {
  const text = source.trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const numericTokens = text.match(/\d+(?:[.,]\d+)?/g)?.length ?? 0;
  const naturalWords = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  const functionWords = text.match(
    /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|has|have)\b/gi,
  )?.length ?? 0;
  return lines.length >= 1
    && lines.length <= 4
    && text.length <= 80
    && numericTokens >= 1
    && naturalWords <= 8
    && functionWords <= 1
    && !/[.!?;:]\s*$/.test(text);
}

function looksLikeShortTableCellLabel(block: Doc['blocks'][number]): boolean {
  return block.type !== 'caption' && looksLikeShortTableCellText(block.text ?? '');
}

interface TableCaptionDescription {
  text: string;
  bottom: number;
  sourceStart: number;
  sourceEnd: number;
}

function hasCaptionDescriptionGrammar(value: string): boolean {
  const normalized = value.trim();
  if (/[.!?]\s*$/.test(normalized)) return true;
  const letters = normalized.match(/[A-Za-z]/g) ?? [];
  const uppercaseLetters = letters.filter((letter) => letter === letter.toLocaleUpperCase()).length;
  const words = normalized.match(/[A-Za-z]{2,}/g) ?? [];
  const titleConnectors = normalized.match(
    /\b(?:and|for|from|in|of|on|over|to|versus|via|with|without)\b/gi,
  ) ?? [];
  // IEEE small-caps table descriptions frequently omit terminal punctuation,
  // for example "THE DATA WIDTH ... FOR VARIOUS ELLIPTIC CURVES". Their
  // uppercase phrase structure and natural-language connectors distinguish
  // them from the short numeric/header rows that must remain rasterized.
  if (letters.length >= 12
    && uppercaseLetters / letters.length >= 0.85
    && words.length >= 4
    && titleConnectors.length >= 1) return true;
  if (!/[)]\s*$/.test(normalized)) return false;
  const numericFootnoteMarkers = normalized.match(/\(\s*\d+[a-z]?\s*\)/gi) ?? [];
  const connectors = normalized.match(
    /\b(?:across|among|and|at|between|by|for|from|in|of|on|over|under|using|versus|via|when|with|without)\b/gi,
  ) ?? [];
  // A real caption can legitimately end in an acronym such as `(GPU)`. A
  // column-header row commonly ends in `(1) ... (2)` and contains no natural
  // connective; accepting it as a caption continuation removes the header
  // from the immutable table crop.
  return numericFootnoteMarkers.length <= 1 && connectors.length >= 1;
}

function leadingTableCaptionDescription(
  block: Doc['blocks'][number],
): TableCaptionDescription | undefined {
  const raw = block.text ?? '';
  const sourceLines: Array<{ text: string; start: number }> = [];
  let offset = 0;
  for (const line of raw.split(/\r?\n/)) {
    sourceLines.push({ text: line.trim(), start: offset + Math.max(0, line.indexOf(line.trim())) });
    offset += line.length + 1;
  }
  const firstLine = sourceLines[0]?.text ?? '';
  if (firstLine.length < 8 || firstLine.length > 180) return undefined;
  const normalizeLine = (value: string) => value
    .normalize('NFKC')
    .replace(/\b([A-Z])\s+([A-Z]{2,})\b/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  const firstNormalized = normalizeLine(firstLine);
  if (!hasCaptionDescriptionGrammar(firstNormalized)) return undefined;
  const selected = [sourceLines[0]!];
  // Continue through at most two short uppercase lines before the numeric or
  // column-header body. This preserves wrapped small-caps descriptions while
  // keeping rows such as "Curve BN128 ..." inside the immutable table crop.
  if (!/[.!?]\s*$/.test(firstNormalized)) {
    for (const line of sourceLines.slice(1, 3)) {
      const normalizedLine = normalizeLine(line.text);
      const letters = normalizedLine.match(/[A-Za-z]/g) ?? [];
      const uppercaseLetters = letters.filter((letter) => letter === letter.toLocaleUpperCase()).length;
      const words = normalizedLine.match(/[A-Za-z]{2,}/g) ?? [];
      const numbers = normalizedLine.match(/\d+(?:[.,]\d+)?/g) ?? [];
      if (!letters.length
        || uppercaseLetters / letters.length < 0.85
        || words.length > 12
        || numbers.length > 0) break;
      selected.push(line);
    }
  }
  const normalized = selected.map((line) => normalizeLine(line.text)).join(' ');
  const words = normalized.match(/[A-Za-z]{2,}/g) ?? [];
  const numbers = normalized.match(/\d+(?:[.,]\d+)?/g) ?? [];
  if (words.length < 4 || numbers.length > 2 || !hasCaptionDescriptionGrammar(normalized)) return undefined;
  const sourceStart = selected[0]!.start;
  const sourceEnd = selected.at(-1)!.start + selected.at(-1)!.text.length;
  const prefixCharacters = (block.characterRects ?? []).filter((character) => (
    character.pageIndex === block.pageIndex
    && character.sourceIndex >= sourceStart
    && character.sourceIndex < sourceEnd
    && character.ch.trim()
  ));
  return {
    text: normalized,
    bottom: prefixCharacters.length
      ? Math.max(...prefixCharacters.map((character) => character.rect.y + character.rect.h))
      : block.rect.y + Math.min(block.rect.h, selected.length * 12),
    sourceStart,
    sourceEnd,
  };
}

function tableCaptionDescription(
  block: Doc['blocks'][number],
  pageIndex: number,
): TableCaptionDescription | undefined {
  const leading = leadingTableCaptionDescription(block);
  if (leading) return leading;
  const rawPrefix = (block.text ?? '').match(
    /^(.{8,180}?[.)])(?=\s+(?:ASIC|CPU|GPU|FPGA|Application|Curve|Size|Modules|Frequency|Area|Dyn|Lkg)\b|$)/i,
  )?.[1];
  if (rawPrefix) {
    const firstLineBandBottom = block.rect.y + Math.min(block.rect.h, 16);
    const prefixCharacters = (block.characterRects ?? []).filter((character) => (
      character.pageIndex === pageIndex
      && character.sourceIndex >= 0
      && character.sourceIndex < rawPrefix.length
      && character.ch.trim()
      // Some PDF text aggregates reuse or offset source indexes, making the
      // caption prefix appear to own cells several rows lower. Only trust
      // glyphs in the physical first-line band; the block's top is the safe
      // fallback for a leading description.
      && character.rect.y >= block.rect.y - 2
      && character.rect.y <= firstLineBandBottom
    ));
    const normalized = rawPrefix
      .replace(/\b([A-Z])\s+([A-Z]{2,})\b/g, '$1$2')
      .replace(/\s+/g, ' ')
      .trim();
    const words = normalized.match(/[A-Za-z]{2,}/g) ?? [];
    const numbers = normalized.match(/\d+(?:[.,]\d+)?/g) ?? [];
    if (words.length >= 4 && numbers.length <= 2 && hasCaptionDescriptionGrammar(normalized)) {
      return {
        text: normalized,
        bottom: prefixCharacters.length
          ? Math.max(...prefixCharacters.map((character) => character.rect.y + character.rect.h))
          : block.rect.y + Math.min(block.rect.h, 12),
        sourceStart: 0,
        sourceEnd: rawPrefix.length,
      };
    }
  }
  const rows: CharacterRect[][] = [];
  for (const character of (block.characterRects ?? [])
    .filter((candidate) => candidate.pageIndex === pageIndex && candidate.ch.trim())
    .sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x)) {
    const center = character.rect.y + character.rect.h / 2;
    const row = rows.find((candidate) => {
      const first = candidate[0]!;
      return Math.abs(first.rect.y + first.rect.h / 2 - center) <= 2.5;
    });
    if (row) row.push(character);
    else rows.push([character]);
  }
  const firstRow = rows[0];
  let text: string;
  let sourceStart: number;
  let sourceEnd: number;
  let bottom: number;
  if (firstRow?.length) {
    text = visualCharacterRowText(firstRow);
    sourceStart = Math.min(...firstRow.map((character) => character.sourceIndex));
    sourceEnd = Math.max(...firstRow.map((character) => character.sourceIndex + character.ch.length));
    bottom = Math.max(...firstRow.map((character) => character.rect.y + character.rect.h));
  } else {
    return undefined;
  }
  const normalized = text
    .replace(/\b([A-Z])\s+([A-Z]{2,})\b/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  const words = normalized.match(/[A-Za-z]{2,}/g) ?? [];
  const numbers = normalized.match(/\d+(?:[.,]\d+)?/g) ?? [];
  if (words.length < 4 || numbers.length > 2 || !hasCaptionDescriptionGrammar(normalized)) return undefined;
  return { text: normalized, bottom, sourceStart, sourceEnd };
}

function attachTableCaptionDescriptions(
  inputUnits: SemanticUnit[],
  regions: LayoutRegion[],
  assets: DetectedAssetRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): SemanticUnit[] {
  let units = inputUnits;
  const removedIds = new Set<string>();
  for (const asset of assets.filter((candidate) => candidate.kind === 'table' && candidate.captionUnitId)) {
    const caption = units.find((unit) => unit.id === asset.captionUnitId);
    const captionBlock = asset.captionUnitId ? blocks.get(asset.captionUnitId) : undefined;
    if (!caption?.sourceText || !captionBlock) continue;
    const captionBottom = captionBlock.rect.y + captionBlock.rect.h;
    const candidate = [...blocks.values()]
      .filter((block) => block.id !== caption.id && block.pageIndex === asset.pageIndex)
      .map((block) => ({ block, description: tableCaptionDescription(block, asset.pageIndex) }))
      .filter((item): item is { block: Doc['blocks'][number]; description: TableCaptionDescription } => {
        if (!item.description) return false;
        const horizontalOverlap = Math.max(0, Math.min(
          item.block.rect.x + item.block.rect.w,
          asset.rect.x + asset.rect.w,
        ) - Math.max(item.block.rect.x, asset.rect.x));
        const top = item.description.bottom - Math.min(item.block.rect.h, 12);
        return horizontalOverlap >= Math.min(item.block.rect.w, asset.rect.w) * 0.25
          && top >= captionBottom - 3
          && top <= asset.rect.y + 20;
      })
      .sort((left, right) => left.description.bottom - right.description.bottom)[0]
      // A malformed aggregate can make every character-based prefix box look
      // lower than the Vision crop. The physical block immediately below a
      // narrow table label is still an unambiguous fallback when its first
      // line has caption-description grammar.
      ?? [...blocks.values()]
        .filter((block) => block.id !== caption.id && block.pageIndex === asset.pageIndex)
        .map((block) => ({ block, description: leadingTableCaptionDescription(block) }))
        .filter((item): item is { block: Doc['blocks'][number]; description: TableCaptionDescription } => {
          if (!item.description) return false;
          const horizontalOverlap = Math.max(0, Math.min(
            item.block.rect.x + item.block.rect.w,
            captionBlock.rect.x + captionBlock.rect.w,
          ) - Math.max(item.block.rect.x, captionBlock.rect.x));
          const gap = item.block.rect.y - captionBottom;
          return gap >= -3
            && gap <= 28
            && horizontalOverlap >= Math.min(item.block.rect.w, captionBlock.rect.w) * 0.45;
        })
        .sort((left, right) => left.block.rect.y - right.block.rect.y)[0];
    if (!candidate) continue;
    const normalizedCaption = caption.sourceText.replace(/\s+/g, '').toLocaleUpperCase();
    const normalizedDescription = candidate.description.text.replace(/\s+/g, '').toLocaleUpperCase();
    if (!normalizedCaption.includes(normalizedDescription)) {
      caption.sourceText = `${caption.sourceText.trim()}\n${candidate.description.text}`;
      caption.protectedTokens = extractProtectedTokens(caption.sourceText);
    }
    const sourceUnit = units.find((unit) => (unit.sourceBlockId ?? unit.id) === candidate.block.id);
    if (sourceUnit?.sourceText) {
      const raw = sourceUnit.sourceText;
      const cleaned = `${raw.slice(0, candidate.description.sourceStart)} ${raw.slice(candidate.description.sourceEnd)}`
        .replace(/\s+/g, ' ')
        .trim();
      const visualBodyCoverage = intersectionArea(candidate.block.rect, asset.rect)
        / Math.max(1, candidate.block.rect.w * candidate.block.rect.h);
      // A PDF text aggregate may join a one-line caption continuation to only
      // one or two table header/cell rows.  After moving the continuation into
      // the caption, that short remainder no longer satisfies the four-line
      // visual-label heuristic.  If the same source block is materially inside
      // the immutable table crop and the remainder still has table-cell
      // grammar (few words, at least one number, almost no function words), the
      // pixels are authoritative and the duplicate text layer must disappear.
      const coveredTableLabels = visualBodyCoverage >= 0.45
        && (looksLikeVisualLabels(candidate.block) || looksLikeShortTableCellText(cleaned));
      if (cleaned && !coveredTableLabels) {
        sourceUnit.sourceText = cleaned;
        sourceUnit.protectedTokens = extractProtectedTokens(cleaned);
      } else {
        removedIds.add(sourceUnit.id);
      }
    }
    const bottom = asset.rect.y + asset.rect.h;
    const top = Math.max(asset.rect.y, candidate.description.bottom + 3);
    if (top < bottom - 12) asset.rect = { ...asset.rect, y: top, h: bottom - top };
  }
  if (!removedIds.size) return units;
  units = units.filter((unit) => !removedIds.has(unit.id));
  for (const region of regions) {
    region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !removedIds.has(unitId));
  }
  return units;
}

interface CenteredSpanningTableGeometry {
  rect: Rect;
  bodyIds: string[];
}

interface PrecedingTableGeometry {
  rect: Rect;
}

/** Recover a numeric table placed immediately above its caption. */
function precedingTableGeometry(
  doc: Doc,
  caption: Doc['blocks'][number],
): PrecedingTableGeometry | undefined {
  const page = doc.pages[caption.pageIndex];
  if (!page) return undefined;
  const candidate = doc.blocks
    .map((block) => ({ block, rect: physicalRectOnPage(block, caption.pageIndex) }))
    .filter((entry): entry is { block: Doc['blocks'][number]; rect: Rect } => Boolean(entry.rect))
    .filter(({ block, rect }) => {
      if (block.id === caption.id || !looksLikeNumericTableBody(block)) return false;
      const gap = caption.rect.y - (rect.y + rect.h);
      const overlap = Math.max(0, Math.min(
        rect.x + rect.w,
        caption.rect.x + caption.rect.w,
      ) - Math.max(rect.x, caption.rect.x));
      return gap >= -2
        && gap <= 18
        && rect.h >= 18
        && overlap >= Math.min(rect.w, caption.rect.w) * 0.45;
    })
    .sort((left, right) => (
      right.rect.y + right.rect.h - (left.rect.y + left.rect.h)
      || left.block.order - right.block.order
    ))[0];
  if (!candidate) return undefined;
  const column = visualColumnBounds(doc, caption);
  const top = Math.max(page.height * 0.04, candidate.rect.y - 6);
  const bottom = caption.rect.y - 4;
  if (bottom - top < 18) return undefined;
  return { rect: { x: column.x, y: top, w: column.w, h: bottom - top } };
}

/**
 * Confirm that a parser caption is followed by a numeric table body before
 * the next structural boundary. This is deliberately content- and
 * geometry-based: terminal floats can be emitted after a bibliography in PDF
 * extraction order even though they are physically above its heading.
 */
function hasFollowingNumericTableBody(
  doc: Doc,
  caption: Doc['blocks'][number],
): boolean {
  const page = doc.pages[caption.pageIndex];
  if (!page) return false;
  const captionBottom = caption.rect.y + caption.rect.h;
  const nextBoundary = doc.blocks
    .filter((block) => (
      block.id !== caption.id
      && block.pageIndex === caption.pageIndex
      && (block.type === 'caption' || block.type === 'section' || block.type === 'title')
      && block.rect.y >= captionBottom + 2
    ))
    .sort((left, right) => left.rect.y - right.rect.y)[0];
  const searchBottom = Math.min(
    nextBoundary?.rect.y ?? page.height,
    captionBottom + page.height * 0.24,
  );
  return doc.blocks.some((block) => {
    if (block.id === caption.id || block.pageIndex !== caption.pageIndex) return false;
    if (block.rect.y < captionBottom - 2 || block.rect.y + block.rect.h > searchBottom + 2) return false;
    if (!looksLikeNumericTableBody(block)) return false;
    const horizontalOverlap = Math.max(0, Math.min(
      block.rect.x + block.rect.w,
      caption.rect.x + caption.rect.w,
    ) - Math.max(block.rect.x, caption.rect.x));
    return horizontalOverlap >= Math.min(block.rect.w, caption.rect.w) * 0.2;
  });
}

/**
 * A spanning table title can be emitted as a tiny block whose centre falls a
 * few points into one column, while the duplicate full table text aggregate is
 * removed during parser normalization. Recover the physical table from the
 * numeric label blocks that remain on both sides of the centre gutter.
 */
function centeredSpanningTableGeometry(
  doc: Doc,
  caption: Doc['blocks'][number],
): CenteredSpanningTableGeometry | undefined {
  const page = doc.pages[caption.pageIndex];
  if (!page || caption.widthMode !== 'column') return undefined;
  const midpoint = page.width / 2;
  const captionCenter = caption.rect.x + caption.rect.w / 2;
  if (Math.abs(captionCenter - midpoint) > page.width * 0.065) return undefined;

  const captionBottom = caption.rect.y + caption.rect.h;
  const nextCaption = doc.blocks
    .filter((block) => (
      block.id !== caption.id
      && block.pageIndex === caption.pageIndex
      && block.type === 'caption'
      && block.rect.y >= captionBottom + 24
    ))
    .sort((left, right) => left.rect.y - right.rect.y)[0];
  const searchBottom = nextCaption?.rect.y ?? Math.min(page.height * 0.55, captionBottom + page.height * 0.3);
  const candidates = doc.blocks.filter((block) => (
    block.id !== caption.id
    && block.pageIndex === caption.pageIndex
    && block.rect.y >= captionBottom - 2
    && block.rect.y + block.rect.h <= searchBottom + 2
    && (looksLikeNumericTableBody(block) || looksLikeShortTableCellLabel(block))
  ));
  const left = candidates.filter((block) => block.rect.x + block.rect.w / 2 < midpoint);
  const right = candidates.filter((block) => block.rect.x + block.rect.w / 2 >= midpoint);
  if (!left.length || !right.length) return undefined;

  const tableBottom = Math.max(...candidates.map((block) => block.rect.y + block.rect.h)) + 6;
  if (tableBottom <= captionBottom + 12) return undefined;
  const x = Math.min(
    page.width * 0.07,
    Math.min(...candidates.map((block) => block.rect.x)) - 6,
  );
  const rightEdge = Math.max(
    page.width * 0.93,
    Math.max(...candidates.map((block) => block.rect.x + block.rect.w)) + 6,
  );
  return {
    rect: {
      x,
      y: captionBottom + 1,
      w: rightEdge - x,
      h: Math.min(tableBottom, searchBottom - 4) - (captionBottom + 1),
    },
    bodyIds: candidates.map((block) => block.id),
  };
}

/** Stop a following figure after the contiguous numeric body of a preceding table. */
function precedingTableBodyBottom(
  doc: Doc,
  figureCaption: Doc['blocks'][number],
): number | undefined {
  const page = doc.pages[figureCaption.pageIndex];
  if (!page) return undefined;
  const pageWidth = page.width;
  const tableCaption = doc.blocks
    .filter((block) => (
      block.pageIndex === figureCaption.pageIndex
      && block.type === 'caption'
      && isTableCaptionText(block.text ?? '')
      && block.rect.y + block.rect.h < figureCaption.rect.y - 24
      && (
        sameVisualColumn(block, figureCaption, pageWidth)
        || Math.abs(block.rect.x + block.rect.w / 2 - pageWidth / 2) <= pageWidth * 0.065
      )
    ))
    .sort((left, right) => right.rect.y - left.rect.y)[0];
  if (!tableCaption) return undefined;

  const captionBottom = tableCaption.rect.y + tableCaption.rect.h;
  const candidates = doc.blocks
    .filter((block) => (
      block.id !== tableCaption.id
      && block.pageIndex === figureCaption.pageIndex
      && block.rect.y >= captionBottom - 2
      && block.rect.y + block.rect.h < figureCaption.rect.y - 18
      && looksLikeNumericTableBody(block)
      && (
        sameVisualColumn(block, figureCaption, pageWidth)
        || tableCaption.rect.x < pageWidth / 2 && tableCaption.rect.x + tableCaption.rect.w > pageWidth / 2
      )
    ))
    .sort((left, right) => left.rect.y - right.rect.y);
  if (!candidates.length || candidates[0]!.rect.y > captionBottom + 48) return undefined;

  let bottom = captionBottom;
  let consumed = 0;
  for (const candidate of candidates) {
    if (consumed && candidate.rect.y > bottom + 14) break;
    bottom = Math.max(bottom, candidate.rect.y + candidate.rect.h);
    consumed += 1;
  }
  return consumed ? bottom : undefined;
}

function visualColumnBounds(doc: Doc, anchor: Doc['blocks'][number]): { x: number; w: number } {
  const pageWidth = doc.pages[anchor.pageIndex]?.width ?? doc.meta.paperWidth;
  const columnBlocks = doc.blocks.filter((block) => (
    block.pageIndex === anchor.pageIndex
    && sameVisualColumn(block, anchor, pageWidth)
    && !(
      anchor.widthMode === 'column'
      && block.rect.w < pageWidth * 0.15
      && block.rect.x < pageWidth / 2
      && block.rect.x + block.rect.w > pageWidth / 2
    )
  ));
  if (!columnBlocks.length) return { x: anchor.rect.x, w: anchor.rect.w };
  let x = Math.min(...columnBlocks.map((block) => block.rect.x));
  let right = Math.max(...columnBlocks.map((block) => block.rect.x + block.rect.w));
  if (anchor.widthMode === 'span' && right - x < pageWidth * 0.6) {
    return { x: pageWidth * 0.08, w: pageWidth * 0.84 };
  }
  if (anchor.widthMode === 'column') {
    const midpoint = pageWidth / 2;
    const gutter = pageWidth * 0.012;
    const outerMargin = pageWidth * 0.07;
    if (anchor.rect.x + anchor.rect.w / 2 < midpoint) {
      x = Math.max(x, outerMargin);
      right = Math.min(right, midpoint - gutter);
    } else {
      x = Math.max(x, midpoint + gutter);
      right = Math.min(right, pageWidth - outerMargin);
    }
    if (right <= x) return { x: anchor.rect.x, w: anchor.rect.w };
  }
  return { x, w: right - x };
}

function clampColumnTableToGutter(doc: Doc, asset: DetectedAssetRegion): void {
  if (asset.kind !== 'table' || asset.widthMode !== 'column') return;
  const page = doc.pages[asset.pageIndex];
  const caption = asset.captionUnitId
    ? doc.blocks.find((block) => block.id === asset.captionUnitId)
    : undefined;
  if (!page || !caption || asset.rect.w >= page.width * 0.62) return;
  const midpoint = page.width / 2;
  const gutter = Math.max(6, page.width * 0.012);
  const captionOnLeft = caption.rect.x + caption.rect.w / 2 < midpoint;
  if (captionOnLeft && asset.rect.x + asset.rect.w > midpoint - gutter) {
    asset.rect = { ...asset.rect, w: midpoint - gutter - asset.rect.x };
  } else if (!captionOnLeft && asset.rect.x < midpoint + gutter) {
    const right = asset.rect.x + asset.rect.w;
    asset.rect = { ...asset.rect, x: midpoint + gutter, w: right - midpoint - gutter };
  }
}

function clampSpanFigureToCaptionColumn(doc: Doc, asset: DetectedAssetRegion): void {
  if (asset.kind !== 'figure' || asset.widthMode !== 'span' || !asset.captionUnitId) return;
  const page = doc.pages[asset.pageIndex];
  const caption = doc.blocks.find((block) => block.id === asset.captionUnitId);
  if (!page || !caption || caption.widthMode !== 'column' || asset.rect.w < page.width * 0.62) return;
  const column = visualColumnBounds(doc, caption);
  if (column.w > page.width * 0.55) return;
  const captionOnLeft = caption.rect.x + caption.rect.w / 2 < page.width / 2;
  const oppositeProse = doc.blocks.some((block) => {
    if (block.pageIndex !== asset.pageIndex || block.id === caption.id || block.type !== 'paragraph') return false;
    const blockOnLeft = block.rect.x + block.rect.w / 2 < page.width / 2;
    if (blockOnLeft === captionOnLeft) return false;
    const verticalOverlap = Math.max(0, Math.min(
      block.rect.y + block.rect.h,
      asset.rect.y + asset.rect.h,
    ) - Math.max(block.rect.y, asset.rect.y));
    const words = block.text?.match(/[A-Za-z]{3,}/g) ?? [];
    return words.length >= 8 && verticalOverlap / Math.max(1, block.rect.h) >= 0.45;
  });
  // A short caption is not sufficient evidence that a wide Vision region is
  // really a column figure. Preserve full-width diagrams unless independent
  // natural-language prose occupies the opposite column on the same band.
  if (!oppositeProse) return;
  const left = Math.max(asset.rect.x, column.x);
  const right = Math.min(asset.rect.x + asset.rect.w, column.x + column.w);
  if (right - left < page.width * 0.2) return;
  asset.rect = { ...asset.rect, x: left, w: right - left };
  asset.widthMode = 'column';
}

/**
 * Independent figures or tables on the same horizontal source band must not
 * contain one another's pixels. Vision occasionally returns one coarse box
 * whose right or left edge crosses into a neighbouring asset. Resolve only
 * genuine sibling overlaps: vertical alignment, ordered centres and a
 * meaningful remaining width are all required. A clearly wider box yields to
 * the narrower neighbour; otherwise the overlap is divided evenly.
 */
function clampOverlappingSiblingAssets(
  doc: Doc,
  assets: DetectedAssetRegion[],
): void {
  const groups = new Map<string, DetectedAssetRegion[]>();
  for (const asset of assets) {
    if ((asset.kind !== 'figure' && asset.kind !== 'table') || asset.widthMode !== 'column') continue;
    const key = `${asset.pageIndex}:${asset.kind}`;
    const group = groups.get(key) ?? [];
    group.push(asset);
    groups.set(key, group);
  }

  for (const siblings of groups.values()) {
    siblings.sort((left, right) => left.rect.x - right.rect.x || left.rect.y - right.rect.y);
    for (let index = 0; index < siblings.length - 1; index += 1) {
      const left = siblings[index]!;
      const right = siblings[index + 1]!;
      const leftCenter = left.rect.x + left.rect.w / 2;
      const rightCenter = right.rect.x + right.rect.w / 2;
      if (rightCenter <= leftCenter) continue;
      const verticalOverlap = Math.max(0, Math.min(
        left.rect.y + left.rect.h,
        right.rect.y + right.rect.h,
      ) - Math.max(left.rect.y, right.rect.y));
      if (verticalOverlap / Math.max(1, Math.min(left.rect.h, right.rect.h)) < 0.6) continue;

      const leftEdge = left.rect.x;
      const leftRight = left.rect.x + left.rect.w;
      const rightLeft = right.rect.x;
      const rightEdge = right.rect.x + right.rect.w;
      if (leftRight <= rightLeft + 1) continue;
      const pageWidth = doc.pages[left.pageIndex]?.width ?? doc.meta.paperWidth;
      const minimumWidth = Math.max(24, pageWidth * 0.08);
      const leftClearlyCoarser = left.rect.w >= right.rect.w * 1.2;
      const rightClearlyCoarser = right.rect.w >= left.rect.w * 1.2;
      // Keep a small source-space gutter when one side is demonstrably coarse.
      // Canvas cropping floors the origin and ceils the width; an exact shared
      // edge can otherwise copy the neighbour's first raster column back into
      // the cropped image as a visible text sliver.
      const boundary = leftClearlyCoarser
        ? rightLeft - 2
        : rightClearlyCoarser
          ? leftRight + 2
          : (leftRight + rightLeft) / 2;

      if (boundary - leftEdge < minimumWidth || rightEdge - boundary < minimumWidth) continue;
      if (!rightClearlyCoarser) {
        left.rect = { ...left.rect, w: boundary - leftEdge };
      }
      if (!leftClearlyCoarser) {
        right.rect = { ...right.rect, x: boundary, w: rightEdge - boundary };
      }
    }
  }
}

function detectedPageFurnitureIds(doc: Doc): Set<string> {
  const ids = new Set<string>();
  const repeatedMargins = new Map<string, Array<{ id: string; pageIndex: number }>>();
  for (const block of doc.blocks) {
    const pageHeight = doc.pages[block.pageIndex]?.height ?? doc.meta.paperHeight;
    const nearMargin = block.rect.y < pageHeight * 0.12
      || block.rect.y + block.rect.h > pageHeight * 0.92;
    const normalized = block.text?.trim().replace(/\s+/g, ' ') ?? '';
    // IEEE first-page editorial notes and affiliation footnotes are outside
    // the paper's reading flow. They can begin well above the physical bottom
    // margin and continue through several blocks, so margin proximity alone
    // is not a sufficient precondition.
    if (
      block.pageIndex === 0
      && block.rect.y >= pageHeight * 0.65
      && /(?:Manuscript received|This work was supported|Recommended for acceptance|Corresponding author|\bis with\b.*(?:University|Institute|Company)|e-?mail\s*:|Digital Object Identifier|Personal use is permitted|See\s+https?:\/\/www[.]ieee[.]org\/publications\/rights)/i.test(normalized)
    ) {
      ids.add(block.id);
    }
    if (!nearMargin) continue;
    if (/^(?:page\s*)?(?:\d+|[ivxlcdm]+)(?:\s*(?:\/|of)\s*\d+)?$/i.test(normalized)) {
      ids.add(block.id);
    }
    if (normalized && normalized.length <= 160) {
      const key = normalized.toLocaleLowerCase();
      const records = repeatedMargins.get(key) ?? [];
      records.push({ id: block.id, pageIndex: block.pageIndex });
      repeatedMargins.set(key, records);
    }
  }
  for (const records of repeatedMargins.values()) {
    if (new Set(records.map((record) => record.pageIndex)).size < 2) continue;
    records.forEach((record) => ids.add(record.id));
  }
  return ids;
}

function isAlgorithmCaptionText(source: string | undefined): boolean {
  return /^\s*(?:algorithm|算法)\s*\d+[A-Za-z]?\b/i.test(source ?? '');
}

function looksLikeAlgorithmBodyBlock(block: Doc['blocks'][number]): boolean {
  if (block.type === 'equation') return true;
  const text = block.text?.trim() ?? '';
  if (!text) return false;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const numberedLines = lines.filter((line) => /^\d+\s*:/.test(line)).length;
  const algorithmKeywords = lines.filter((line) => (
    /^(?:require|ensure|input|output|return|for\b|while\b|if\b|else\b|end\b|\/\/)/i.test(line)
  )).length;
  const mathematicalLines = lines.filter((line) => /[←→∑≫≪⌈⌉]|\b(?:do|then|end for|end if)\b/i.test(line)).length;
  return numberedLines + algorithmKeywords + mathematicalLines >= Math.max(1, Math.ceil(lines.length * 0.25));
}

function isAlgorithmProseBoundary(block: Doc['blocks'][number]): boolean {
  if (block.type === 'caption' || block.type === 'section' || block.type === 'title') return true;
  const text = block.text?.trim() ?? '';
  if (text.length < 80) return false;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0] ?? '';
  const firstLineIsAlgorithm = /^\d+\s*:|^(?:require|ensure|input|output|return|for\b|while\b|if\b|else\b|end\b|\/\/)/i.test(firstLine);
  const firstLineWords = firstLine.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  const firstLineFunctionWords = firstLine.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|while)\b/gi)?.length ?? 0;
  // PDF.js can merge the prose immediately after an algorithm with numbered
  // instructions that physically continue on the next page. The current-page
  // leading line is authoritative: do not let later instruction lines turn
  // already-started prose back into an algorithm crop.
  if (!firstLineIsAlgorithm && firstLineWords >= 8 && firstLineFunctionWords >= 2) return true;
  const hasNumberedInstruction = lines.some((line) => /^\d+\s*:/.test(line));
  const hasAlgorithmHeader = /^(?:require|ensure|input|output)\s*:/i.test(lines[0] ?? '');
  if (hasNumberedInstruction || hasAlgorithmHeader) return false;
  const naturalWords = text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  const functionWords = text.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/gi)?.length ?? 0;
  return naturalWords >= 12 && functionWords >= 3;
}

function detectedAlgorithmAssets(doc: Doc): DetectedAssetRegion[] {
  const blocks = new Map(doc.blocks.map((block) => [block.id, block]));
  const assets: DetectedAssetRegion[] = [];
  for (const caption of doc.semanticUnits.filter((unit) => (
    unit.kind === 'caption' && isAlgorithmCaptionText(unit.sourceText)
  ))) {
    const captionBlock = blocks.get(caption.id);
    if (!captionBlock) continue;
    const pageWidth = doc.pages[captionBlock.pageIndex]?.width ?? doc.meta.paperWidth;
    const captionBottom = captionBlock.rect.y + captionBlock.rect.h;
    const candidates = doc.blocks
      .filter((block) => (
        block.pageIndex === captionBlock.pageIndex
        && block.rect.y >= captionBottom - 1
        && (
          captionBlock.widthMode === 'span'
          || sameVisualColumn(block, captionBlock, pageWidth)
          || (
            block.widthMode === 'span'
            && Math.abs(block.rect.x - captionBlock.rect.x) <= 24
          )
          || (
            block.rect.w >= pageWidth * 0.55
            && block.rect.x < captionBlock.rect.x + captionBlock.rect.w
            && block.rect.x + block.rect.w > captionBlock.rect.x
          )
        )
      ))
      .sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x);
    const firstFollowingBoundary = candidates.find((block) => (
      block.rect.y >= captionBottom + 8
      && isAlgorithmProseBoundary(block)
    ));
    const stopY = firstFollowingBoundary?.rect.y ?? Number.POSITIVE_INFINITY;
    const algorithmLikeBlocks = candidates.filter((block) => (
      block.rect.y < stopY
      && looksLikeAlgorithmBodyBlock(block)
    ));
    const bodyBlocks: typeof algorithmLikeBlocks = [];
    let clusterBottom = captionBottom + 4;
    for (const block of algorithmLikeBlocks) {
      // Formula fragments belonging to a later figure or body section can
      // resemble pseudocode. Algorithm lines themselves form a vertically
      // continuous cluster, so stop before a detached second cluster.
      if (bodyBlocks.length >= 2 && block.rect.y > clusterBottom + 32) break;
      bodyBlocks.push(block);
      clusterBottom = Math.max(clusterBottom, block.rect.y + block.rect.h);
    }
    if (bodyBlocks.length < 2) continue;
    const inkLeft = Math.min(captionBlock.rect.x, ...bodyBlocks.map((block) => block.rect.x));
    const inkRight = Math.max(
      captionBlock.rect.x + captionBlock.rect.w,
      ...bodyBlocks.map((block) => block.rect.x + block.rect.w),
    );
    const bodyBottom = Math.max(...bodyBlocks.map((block) => block.rect.y + block.rect.h));
    const firstBodyTop = Math.min(...bodyBlocks.map((block) => block.rect.y));
    // The first body text geometry is a stronger lower boundary than the
    // caption font box: PDF font metrics can under-report title descenders and
    // leave fragments of the original caption in the crop. Start immediately
    // before the first pseudocode glyph and intentionally omit the top rule.
    const top = Math.max(captionBottom + 1, firstBodyTop - 0.5);
    const bottom = Number.isFinite(stopY)
      ? Math.min(stopY - 3, bodyBottom + 8)
      : bodyBottom + 8;
    if (bottom <= top + 12) continue;
    const layoutRegion = doc.layoutRegions.find((region) => region.id === caption.layoutRegionId);
    const midpoint = pageWidth / 2;
    const gutter = Math.max(6, pageWidth * 0.012);
    const wideRegion = captionBlock.widthMode === 'span'
      || bodyBlocks.some((block) => block.rect.w >= pageWidth * 0.55)
      || (inkLeft < midpoint - gutter && inkRight > midpoint + gutter);
    const cropLeft = Math.max(0, wideRegion
      ? Math.min(inkLeft - 2, layoutRegion!.bounds.x - 2)
      : inkLeft - 2);
    const cropRight = Math.min(pageWidth, wideRegion
      ? Math.max(inkRight + 2, layoutRegion!.bounds.x + layoutRegion!.bounds.w + 2)
      : inkRight + 2);
    const bodyWidth = cropRight - cropLeft;
    assets.push({
      id: `${caption.id}-body-asset`,
      kind: 'code',
      pageIndex: captionBlock.pageIndex,
      rect: { x: cropLeft, y: top, w: bodyWidth, h: bottom - top },
      // PDF text extraction sometimes labels a page-spanning algorithm
      // caption as a column item. The physical crop is authoritative here:
      // rendering a wide algorithm at column width makes the pseudocode
      // illegible even though all of its pixels were preserved.
      widthMode: wideRegion || bodyWidth >= pageWidth * 0.55 ? 'span' : captionBlock.widthMode,
      captionUnitId: caption.id,
    });
  }
  return assets;
}

function formulaDuplicatesDeterministicAlgorithm(
  asset: DetectedAssetRegion,
  algorithms: readonly DetectedAssetRegion[],
  candidates: readonly DetectedAssetRegion[],
): boolean {
  if (asset.kind !== 'formula') return false;
  return algorithms.some((algorithm) => {
    if (algorithm.pageIndex !== asset.pageIndex) return false;
    const horizontalOverlap = Math.max(0, Math.min(
      asset.rect.x + asset.rect.w,
      algorithm.rect.x + algorithm.rect.w,
    ) - Math.max(asset.rect.x, algorithm.rect.x));
    if (horizontalOverlap < Math.min(asset.rect.w, algorithm.rect.w) * 0.45) return false;
    const overlapRatio = intersectionArea(asset.rect, algorithm.rect)
      / Math.max(1, asset.rect.w * asset.rect.h);
    if (overlapRatio >= 0.2) return true;

    // Vision frequently emits every pseudocode row as an independent formula.
    // The final row can begin just beyond the padded deterministic crop. Treat
    // that short continuation as part of the same duplicate cluster only when
    // another formula proposal demonstrably lies inside the algorithm body.
    const hasOverlappingCluster = candidates.some((candidate) => (
      candidate.id !== asset.id
      && candidate.kind === 'formula'
      && candidate.pageIndex === algorithm.pageIndex
      && intersectionArea(candidate.rect, algorithm.rect)
        / Math.max(1, candidate.rect.w * candidate.rect.h) >= 0.2
    ));
    const verticalGap = Math.max(
      0,
      asset.rect.y - (algorithm.rect.y + algorithm.rect.h),
      algorithm.rect.y - (asset.rect.y + asset.rect.h),
    );
    return hasOverlappingCluster && verticalGap <= 8;
  });
}

function formulaCoversStructuralText(doc: Doc, asset: DetectedAssetRegion): boolean {
  if (asset.kind !== 'formula') return false;
  const structuralBlockIds = new Set(doc.semanticUnits
    .filter((unit) => ['title', 'heading', 'caption', 'table-title'].includes(unit.kind))
    .map((unit) => unit.sourceBlockId ?? unit.id));
  return doc.blocks.some((block) => {
    if (!structuralBlockIds.has(block.id)) return false;
    const rect = physicalRectOnPage(block, asset.pageIndex);
    if (!rect) return false;
    return intersectionArea(rect, asset.rect) / Math.max(1, rect.w * rect.h) >= 0.5;
  });
}

function embeddedCaptionText(source: string, kind: 'figure' | 'table'): string | undefined {
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const start = lines.findIndex((line) => (
    kind === 'figure' ? isFigureCaptionText(line) : isTableCaptionText(line)
  ));
  if (start < 0) return undefined;
  const caption = [lines[start]!];
  if (/[.!?。！？]\s*$/.test(lines[start]!)) return caption[0];
  for (const line of lines.slice(start + 1, start + 4)) {
    if (isFigureCaptionText(line) || isTableCaptionText(line)) break;
    const words = line.match(/[A-Za-z]{2,}/g) ?? [];
    const functionWords = line.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|has|have)\b/gi) ?? [];
    if (words.length < 4 || functionWords.length < 1) break;
    caption.push(line);
    if (/[.!?。！？]\s*$/.test(line)) break;
  }
  return caption.join(' ');
}

function splitMergedCaptionText(source: string): Array<{ kind: 'figure' | 'table'; text: string }> {
  const starts = [...source.matchAll(/\b(Figure|Table)\s+\d+[A-Za-z]?\s*[:.]\s*/gi)];
  if (starts.length < 2) return [];
  return starts.map((match, index) => ({
    kind: match[1]!.toLocaleLowerCase() as 'figure' | 'table',
    text: source.slice(match.index!, starts[index + 1]?.index ?? source.length).trim(),
  })).filter((segment) => segment.text.length > 0);
}

function isBibliographyHeading(source: string | undefined): boolean {
  const compact = (source ?? '').trim().replace(/\s+/g, '');
  return /^(?:references|bibliography|参考文献)$/i.test(compact);
}

export function authorBiographyStart(source: string | undefined): number | undefined {
  if (!source) return undefined;
  const match = source.match(
    /(?:^|\n)(?=[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){1,4}(?:\s+\([^\n)]*IEEE[^\n)]*\))?\s+(?:received|earned|obtained|is|was|has\s+(?:been|worked)|currently\s+(?:is|works))\b)/m,
  );
  if (match?.index === undefined) return undefined;
  return match.index + (match[0].startsWith('\n') ? 1 : 0);
}

type BibliographyCharacter = CharacterRect & {
  blockId: string;
  blockText: string;
};

function bibliographyRowText(row: BibliographyCharacter[]): string {
  const ordered = [...row].sort((left, right) => left.rect.x - right.rect.x);
  let value = '';
  let previous: BibliographyCharacter | undefined;
  for (const character of ordered) {
    if (previous) {
      const omittedSource = previous.blockId === character.blockId
        && character.sourceIndex > previous.sourceIndex
        ? character.blockText.slice(previous.sourceIndex + 1, character.sourceIndex)
        : '';
      const visualGap = character.rect.x - (previous.rect.x + previous.rect.w);
      if (/\s/.test(omittedSource) || (previous.blockId !== character.blockId && visualGap > 1)) {
        value += ' ';
      }
    }
    value += character.ch;
    previous = character;
  }
  return value.replace(/\s+/g, ' ').trim();
}

function appendBibliographyContinuation(entry: string, line: string): string {
  if (entry.endsWith('-') && /^[a-z]/.test(line)) {
    return `${entry.slice(0, -1)}${line}`;
  }
  if (entry.endsWith('-') && /^\d/.test(line)) return `${entry}${line}`;
  const trailingUrl = entry.match(/https?:\/\/\S+$/i)?.[0];
  if ((trailingUrl && /[./:]$/.test(trailingUrl) && /^[A-Za-z0-9/?#]/.test(line))
    || (/https?:$/i.test(entry) && line.startsWith('//'))) {
    return `${entry}${line}`;
  }
  return `${entry} ${line}`;
}

function physicalHeadingBlock(
  unit: SemanticUnit,
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): Doc['blocks'][number] | undefined {
  return blocks.get(unit.sourceBlockId ?? unit.id);
}

/**
 * PDF reading order is column-based, so a narrow citation-label column can be
 * emitted after the wider bibliography body even when the References heading
 * is physically above both. Rebuild a terminal bibliography from character
 * geometry so labels, bodies, and wrapped lines share one physical sequence.
 */
function rebuildBibliographyFromGeometry(
  doc: Doc,
  inputUnits: SemanticUnit[],
  regions: LayoutRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): SemanticUnit[] {
  const heading = inputUnits
    .filter((unit) => unit.kind === 'heading' && isBibliographyHeading(unit.sourceText))
    .map((unit) => ({ unit, block: physicalHeadingBlock(unit, blocks) }))
    .filter((candidate): candidate is { unit: SemanticUnit; block: Doc['blocks'][number] } => Boolean(candidate.block))
    .sort((left, right) => left.block.pageIndex - right.block.pageIndex || left.block.rect.y - right.block.rect.y)[0];
  if (!heading) return inputUnits;

  const nextHeading = inputUnits
    .filter((unit) => unit.kind === 'heading' && unit.id !== heading.unit.id)
    .map((unit) => physicalHeadingBlock(unit, blocks))
    .filter((block): block is Doc['blocks'][number] => Boolean(block))
    .filter((block) => (
      block.pageIndex > heading.block.pageIndex
      || (block.pageIndex === heading.block.pageIndex
        && block.rect.y > heading.block.rect.y + heading.block.rect.h + 2)
    ))
    .sort((left, right) => left.pageIndex - right.pageIndex || left.rect.y - right.rect.y)[0];

  const headingPage = doc.pages[heading.block.pageIndex];
  const headingPageMidpoint = (headingPage?.width ?? doc.meta.paperWidth) / 2;
  const bibliographyEntryStart = /^\[(?=[^\]\r\n]*\d)[A-Za-z0-9]+(?:\s*\+\s*\d{2,4})?\]/;
  const citationBlocks = doc.blocks.filter((block) => (
    block.order > heading.block.order
    && (!nextHeading || block.order < nextHeading.order)
    && bibliographyEntryStart.test((block.text ?? '').trimStart())
  ));
  const leftCitationBlocks = citationBlocks.filter((block) => block.rect.x < headingPageMidpoint);
  const rightCitationBlocks = citationBlocks.filter((block) => block.rect.x >= headingPageMidpoint);
  const multiColumnBibliography = leftCitationBlocks.length >= 2 && rightCitationBlocks.length >= 2;
  const firstRightCitation = rightCitationBlocks
    .filter((block) => block.pageIndex === heading.block.pageIndex)
    .sort((left, right) => left.rect.y - right.rect.y)[0];
  const rightContinuation = firstRightCitation
    ? doc.blocks
      .filter((block) => (
        block.id !== firstRightCitation.id
        && block.pageIndex === firstRightCitation.pageIndex
        && block.rect.x + block.rect.w / 2 >= headingPageMidpoint
        && block.rect.y < firstRightCitation.rect.y
        && block.rect.y + block.rect.h >= firstRightCitation.rect.y - 6
      ))
      .sort((left, right) => left.rect.y - right.rect.y)[0]
    : undefined;
  const rightColumnBibliographyTop = rightContinuation?.rect.y ?? firstRightCitation?.rect.y;

  const characters: BibliographyCharacter[] = [];
  const seenCharacters = new Set<string>();
  for (const block of doc.blocks) {
    for (const character of block.characterRects ?? []) {
      const page = doc.pages[character.pageIndex];
      if (!page) continue;
      const centerY = character.rect.y + character.rect.h / 2;
      const centerX = character.rect.x + character.rect.w / 2;
      const headingIsNarrowLeftColumn = multiColumnBibliography
        && heading.block.rect.w < page.width * 0.6
        && heading.block.rect.x + heading.block.rect.w / 2 < page.width / 2;
      const followsHeadingInLaterColumn = character.pageIndex === heading.block.pageIndex
        && headingIsNarrowLeftColumn
        && centerX >= page.width / 2
        && rightColumnBibliographyTop !== undefined
        && centerY >= rightColumnBibliographyTop - 2;
      const sameHeadingColumn = (centerX < page.width / 2)
        === (heading.block.rect.x + heading.block.rect.w / 2 < page.width / 2);
      const blockCrossesMidpointFromHeadingLane = block.rect.x < page.width / 2
        && block.rect.x + block.rect.w > page.width / 2
        && block.rect.w >= page.width * 0.5
        && Math.abs(block.rect.x - heading.block.rect.x) <= page.width * 0.12;
      const afterHeading = character.pageIndex > heading.block.pageIndex
        || (character.pageIndex === heading.block.pageIndex
          && (followsHeadingInLaterColumn
            || (centerY > heading.block.rect.y + heading.block.rect.h + 2
              && (multiColumnBibliography || sameHeadingColumn || blockCrossesMidpointFromHeadingLane))));
      const beforeNextHeading = !nextHeading
        || character.pageIndex < nextHeading.pageIndex
        || (character.pageIndex === nextHeading.pageIndex && centerY < nextHeading.rect.y - 2);
      if (!afterHeading || !beforeNextHeading || centerY <= page.height * 0.065 || centerY >= page.height * 0.95) {
        continue;
      }
      const key = [
        character.pageIndex,
        Math.round(character.rect.x * 10),
        Math.round(character.rect.y * 10),
        Math.round(character.rect.w * 10),
        character.ch,
      ].join(':');
      if (seenCharacters.has(key)) continue;
      seenCharacters.add(key);
      characters.push({
        ...character,
        blockId: block.id,
        blockText: block.text ?? '',
      });
    }
  }

  const rows: Array<typeof characters> = [];
  const pageIndexes = [...new Set(characters.map((character) => character.pageIndex))]
    .sort((left, right) => left - right);
  for (const pageIndex of pageIndexes) {
    const page = doc.pages[pageIndex]!;
    const pageCharacters = characters.filter((character) => character.pageIndex === pageIndex);
    const columns = multiColumnBibliography
      ? [
          pageCharacters.filter((character) => character.rect.x + character.rect.w / 2 < page.width / 2),
          pageCharacters.filter((character) => character.rect.x + character.rect.w / 2 >= page.width / 2),
        ]
      : [pageCharacters];
    for (const column of columns) {
      column.sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x);
      for (const character of column) {
        const last = rows.at(-1);
        if (last?.length
          && last[0]!.pageIndex === character.pageIndex
          && Math.abs(last[0]!.rect.y - character.rect.y) <= 1.5
          && (!multiColumnBibliography
            || (last[0]!.rect.x < page.width / 2) === (character.rect.x < page.width / 2))) {
          last.push(character);
        } else {
          rows.push([character]);
        }
      }
    }
  }

  const rowLines = rows.map((row) => ({ row, text: bibliographyRowText(row) }))
    .filter((candidate) => Boolean(candidate.text));
  const biographyLineIndex = rowLines.findIndex((candidate) => (
    authorBiographyStart(candidate.text) === 0
  ));
  const bibliographyRowLines = biographyLineIndex >= 0
    ? rowLines.slice(0, biographyLineIndex)
    : rowLines;
  const selectedBlockIds = new Set(bibliographyRowLines
    .flatMap((candidate) => candidate.row.map((character) => character.blockId)));
  const runningFurnitureKey = (text: string): string => text
    .replace(/^\s*\d{1,4}\s+/, '')
    .replace(/\s+\d{1,4}\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
  const topShortLinePages = new Map<string, Set<number>>();
  for (const candidate of bibliographyRowLines) {
    const first = candidate.row[0];
    const page = first ? doc.pages[first.pageIndex] : undefined;
    const normalized = candidate.text.replace(/\s+/g, ' ').trim();
    if (!first || !page || first.rect.y > page.height * 0.1
      || normalized.length > 40 || bibliographyEntryStart.test(normalized)) continue;
    const key = runningFurnitureKey(normalized);
    if (!key) continue;
    const pages = topShortLinePages.get(key) ?? new Set<number>();
    pages.add(first.pageIndex);
    topShortLinePages.set(key, pages);
  }
  const entries: string[] = [];
  for (const { row, text: rawLine } of bibliographyRowLines) {
    const first = row[0];
    const page = first ? doc.pages[first.pageIndex] : undefined;
    const normalized = rawLine.replace(/\s+/g, ' ').trim();
    const furnitureKey = runningFurnitureKey(normalized);
    const repeatedTopFurniture = Boolean(
      first && page
      && first.rect.y <= page.height * 0.1
      && normalized.length <= 40
      && furnitureKey
      && (topShortLinePages.get(furnitureKey)?.size ?? 0) >= 2,
    );
    const shortAuthorRunningHeader = Boolean(
      first && page
      && first.rect.y <= page.height * 0.1
      && normalized.length <= 40
      && (normalized.match(/[A-Za-z]+/g)?.length ?? 0) <= 6
      && /\bet\s+al\.?(?:\s+\d{1,4})?$/i.test(normalized),
    );
    if (/^\d{1,4}$/.test(normalized) || repeatedTopFurniture || shortAuthorRunningHeader) continue;
    const line = rawLine.replace(
      /^(\[(?=[^\]\r\n]*\d)[A-Za-z0-9]+(?:\s*\+\s*\d{2,4})?\])(?=\S)/,
      '$1 ',
    );
    if (bibliographyEntryStart.test(line)) {
      entries.push(line);
    } else if (entries.length) {
      entries[entries.length - 1] = appendBibliographyContinuation(entries.at(-1)!, line);
    }
  }
  // A single bracketed line can be an ordinary citation-bearing paragraph.
  // Require a real multi-entry bibliography before changing document order.
  if (entries.length < 2) return inputUnits;

  const replacedIds = new Set(inputUnits
    .filter((unit) => (
      unit.id !== heading.unit.id
      && (
        selectedBlockIds.has(unit.sourceBlockId ?? unit.id)
        || (unit.parentId === heading.unit.id && unit.kind === 'reference')
      )
    ))
    .map((unit) => unit.id));
  const targetRegion = regions.find((region) => region.id === heading.unit.layoutRegionId);
  if (!targetRegion) return inputUnits;

  const biographyResiduals = inputUnits.flatMap((unit): SemanticUnit[] => {
    if (!replacedIds.has(unit.id)) return [];
    const start = authorBiographyStart(unit.sourceText);
    if (start === undefined) return [];
    const sourceText = unit.sourceText!.slice(start).trim();
    if (!sourceText) return [];
    return [{
      ...unit,
      id: `${unit.id}-biography`,
      parentId: undefined,
      kind: 'paragraph',
      sourceText,
      protectedTokens: extractProtectedTokens(sourceText),
    }];
  });
  const residualByOriginal = new Map(biographyResiduals.map((unit) => [
    unit.id.replace(/-biography$/, ''), unit,
  ]));
  for (const region of regions) {
    region.orderedUnitIds = region.orderedUnitIds.flatMap((unitId) => {
      if (!replacedIds.has(unitId)) return [unitId];
      const residual = residualByOriginal.get(unitId);
      return residual ? [residual.id] : [];
    });
  }
  const rebuilt = entries.map((sourceText, index): SemanticUnit => ({
    id: `${heading.unit.id}-reference-${index + 1}`,
    parentId: heading.unit.id,
    kind: 'reference',
    sourceText,
    protectedTokens: extractProtectedTokens(sourceText),
    layoutRegionId: targetRegion.id,
    order: heading.unit.order + (index + 1) / 1_000,
  }));
  let headingIndex = targetRegion.orderedUnitIds.indexOf(heading.unit.id);
  if (headingIndex < 0) {
    targetRegion.orderedUnitIds.push(heading.unit.id);
    headingIndex = targetRegion.orderedUnitIds.length - 1;
  }
  targetRegion.orderedUnitIds.splice(headingIndex + 1, 0, ...rebuilt.map((unit) => unit.id));
  return inputUnits.filter((unit) => !replacedIds.has(unit.id)).concat(rebuilt, biographyResiduals);
}

function joinSplitTableFootnoteLine(left: string, right: string): string {
  const head = left.trimEnd();
  const tail = right.trimStart();
  if (!head) return tail;
  if (!tail) return head;
  const leftToken = head.match(/([A-Za-z]+)$/)?.[1] ?? '';
  const rightToken = tail.match(/^([A-Za-z]+(?:-[A-Za-z]+)?)/)?.[1] ?? '';
  const suffixFragment = /^(?:ile|ion|ions|ing|ed|er|ers|ly|ment|tion|sion|ness|able|al|ansfer)$/i
    .test(rightToken);
  const splitInitialism = /^[A-Z]{1,3}$/.test(leftToken) && /^[A-Z](?:[A-Z]|-[A-Z])/.test(rightToken);
  const splitWord = Boolean(leftToken && rightToken)
    && (leftToken.length <= 2 || suffixFragment || splitInitialism);
  return splitWord ? `${head}${tail}` : `${head} ${tail}`;
}

function repairSplitTableFootnotes(
  inputUnits: SemanticUnit[],
  regions: LayoutRegion[],
  assets: DetectedAssetRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): SemanticUnit[] {
  let units = inputUnits;
  const removedIds = new Set<string>();
  for (const asset of assets.filter((candidate) => candidate.kind === 'table')) {
    const assetUnit = units.find((unit) => unit.id === asset.id);
    if (!assetUnit) continue;
    const assetBottom = asset.rect.y + asset.rect.h;
    const candidates = units
      .filter((unit) => unit.id !== asset.id && !removedIds.has(unit.id) && Boolean(unit.sourceText))
      .map((unit) => ({ unit, block: blocks.get(unit.sourceBlockId ?? unit.id) }))
      .filter((candidate): candidate is { unit: SemanticUnit; block: Doc['blocks'][number] } => {
        if (!candidate.block || candidate.block.pageIndex !== asset.pageIndex) return false;
        const horizontalOverlap = Math.max(0, Math.min(
          candidate.block.rect.x + candidate.block.rect.w,
          asset.rect.x + asset.rect.w,
        ) - Math.max(candidate.block.rect.x, asset.rect.x));
        return horizontalOverlap >= Math.min(candidate.block.rect.w, asset.rect.w) * 0.4
          && candidate.block.rect.y <= assetBottom + 80
          && candidate.block.rect.y + candidate.block.rect.h >= assetBottom - 40;
      });
    const anchor = candidates
      .filter((candidate) => /(?:^|\n)\s*\(1\)\s+/.test(candidate.unit.sourceText!))
      .sort((left, right) => left.block.rect.x - right.block.rect.x)[0];
    if (!anchor) continue;
    const partner = candidates
      .filter((candidate) => candidate.unit.id !== anchor.unit.id)
      .filter((candidate) => {
        const overlap = Math.max(0, Math.min(
          anchor.block.rect.y + anchor.block.rect.h,
          candidate.block.rect.y + candidate.block.rect.h,
        ) - Math.max(anchor.block.rect.y, candidate.block.rect.y));
        return candidate.block.rect.x + candidate.block.rect.w / 2
          > anchor.block.rect.x + anchor.block.rect.w / 2
          && overlap / Math.max(1, Math.min(anchor.block.rect.h, candidate.block.rect.h)) >= 0.6
          && !/(?:^|\n)\s*\(1\)\s+/.test(candidate.unit.sourceText!);
      })
      .sort((left, right) => left.block.rect.x - right.block.rect.x)[0];
    if (!partner) continue;
    const leftLines = anchor.unit.sourceText!.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const rightLines = partner.unit.sourceText!.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const markerCount = leftLines.filter((line) => /^\(\d+\)\s+/.test(line)).length;
    if (markerCount < 2 || Math.abs(leftLines.length - rightLines.length) > 1) continue;
    const mergedLines = leftLines.map((line, index) => (
      joinSplitTableFootnoteLine(line, rightLines[index] ?? '')
    ));
    if (rightLines.length > leftLines.length) mergedLines.push(...rightLines.slice(leftLines.length));
    anchor.unit.sourceText = mergedLines.join('\n');
    anchor.unit.protectedTokens = extractProtectedTokens(anchor.unit.sourceText);
    anchor.unit.kind = 'paragraph';
    anchor.unit.parentId = asset.captionUnitId;
    anchor.unit.sourceBlockIds = [
      anchor.unit.sourceBlockId ?? anchor.unit.id,
      partner.unit.sourceBlockId ?? partner.unit.id,
    ];
    anchor.unit.layoutRegionId = assetUnit.layoutRegionId;
    anchor.unit.order = assetUnit.order + 0.01;
    removedIds.add(partner.unit.id);

    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => (
        unitId !== anchor.unit.id && unitId !== partner.unit.id
      ));
    }
    const region = regions.find((candidate) => candidate.id === assetUnit.layoutRegionId);
    const assetIndex = region?.orderedUnitIds.indexOf(asset.id) ?? -1;
    if (region) region.orderedUnitIds.splice(assetIndex < 0 ? region.orderedUnitIds.length : assetIndex + 1, 0, anchor.unit.id);
  }
  if (!removedIds.size) return units;
  units = units.filter((unit) => !removedIds.has(unit.id));
  return units;
}

export function prepareImmutableStructure(doc: Doc, options: PrepareImmutableOptions = {}): PreparedImmutableStructure {
  const regions = doc.layoutRegions.map((region) => ({ ...region, orderedUnitIds: [...region.orderedUnitIds] }));
  const blocks = new Map(doc.blocks.map((block) => [block.id, block]));
  let units: SemanticUnit[] = doc.semanticUnits.map((unit) => ({
    ...unit,
    sourceBlockId: unit.sourceBlockId ?? (blocks.has(unit.id) ? unit.id : undefined),
    protectedTokens: [...unit.protectedTokens],
  }));
  units = splitFirstPageFrontMatter(doc, units, regions, blocks);
  units = mergeFirstPageTitleContinuations(doc, units, regions, blocks);
  units = repairSplitHeadingRows(doc, units, regions, blocks);
  normalizeDocumentTitleRoles(units, blocks);
  normalizeFirstPageFrontMatter(doc, units, blocks);
  normalizeScopedFrontMatterRoles(units, blocks);
  units = normalizeAbstractAndKeywordContinuations(units, regions, blocks);
  units = mergeDanglingUrlFragments(doc, units, regions, blocks);
  units = normalizeHeadingHierarchy(units, regions);
  repairHeadingRegionOrder(doc, units, regions, blocks);
  const assetRegions: DetectedAssetRegion[] = [];
  const algorithmAssets = detectedAlgorithmAssets(doc);
  const fontFormulas = (options.fontFormulaRegions ?? []).filter((formula) => ![
    ...(options.verifiedAssetRegions ?? []), ...algorithmAssets,
  ].some((asset) => asset.kind !== 'formula' && asset.pageIndex === formula.pageIndex
    && intersectionArea(asset.rect, formula.rect) / Math.max(1, formula.rect.w * formula.rect.h) > 0.5))
    .map((formula) => ({ ...formula, sourceCharacterRanges: doc.blocks.flatMap((block) => {
      const characters = (block.characterRects ?? []).filter((character) => character.pageIndex === formula.pageIndex
        && character.ch.trim() && formula.sourceTextRects.some((rect) => (
          intersectionArea(character.rect, rect) / Math.max(0.1, character.rect.w * character.rect.h) > 0.85
        )));
      return characters.map((character) => ({ blockId: block.id,
        start: character.sourceIndex, end: character.sourceIndex + character.ch.length }));
    }) }));
  const suppliedVerifiedAssets = [
    ...(options.verifiedAssetRegions ?? []).filter((asset) => asset.kind !== 'formula'
      || !fontFormulas.some((formula) => formula.pageIndex === asset.pageIndex
        && intersectionArea(asset.rect, formula.rect) / Math.max(1, Math.min(
          asset.rect.w * asset.rect.h, formula.rect.w * formula.rect.h,
        )) > 0.4)).filter((asset) => {
      if (asset.kind !== 'formula' || !fontFormulas.some((formula) => formula.pageIndex === asset.pageIndex)) return true;
      const intersecting = doc.blocks.filter((block) => block.pageIndex === asset.pageIndex
        && intersectionArea(block.rect, asset.rect) > 0);
      // On a native-text page, an empty crop cannot be a text equation. A
      // heading plus a displaced summation glyph is not an equation either.
      if (!intersecting.length) return false;
      const headingIds = new Set(units.filter((unit) => unit.kind === 'heading' || unit.kind === 'title')
        .map((unit) => unit.sourceBlockId));
      if (!intersecting.some((block) => headingIds.has(block.id))) return true;
      const nonHeading = intersecting.filter((block) => !headingIds.has(block.id))
        .flatMap((block) => block.characterRects ?? []).filter((char) => intersectionArea(char.rect, asset.rect) > 0)
        .map((char) => char.ch).join('').replace(/\s/g, '');
      return nonHeading.length >= 3;
    }),
    ...fontFormulas,
  ];
  const retainedAlgorithmAssets: DetectedAssetRegion[] = [];
  const replacedVerifiedCodeIds = new Set<string>();
  for (const algorithm of algorithmAssets) {
    const verified = suppliedVerifiedAssets.find((asset) => (
      asset.kind === 'code'
      && asset.pageIndex === algorithm.pageIndex
      && asset.captionUnitId === algorithm.captionUnitId
    ));
    if (!verified) {
      retainedAlgorithmAssets.push(algorithm);
      continue;
    }
    const algorithmBottom = algorithm.rect.y + algorithm.rect.h;
    const verifiedBottom = verified.rect.y + verified.rect.h;
    const coversVerifiedBody = algorithm.rect.h >= verified.rect.h * 0.65
      && algorithmBottom >= verifiedBottom - Math.max(24, verified.rect.h * 0.15);
    if (coversVerifiedBody) {
      retainedAlgorithmAssets.push(algorithm);
      replacedVerifiedCodeIds.add(verified.id);
    }
    // Otherwise the PDF text layer reconstructed only a fragment of the
    // pseudocode. Keep the complete, locally verified Vision crop instead.
  }
  const deterministicAlgorithmPages = new Set(retainedAlgorithmAssets.map((asset) => asset.pageIndex));
  const verifiedAssetRegions = suppliedVerifiedAssets
    .filter((asset) => !replacedVerifiedCodeIds.has(asset.id))
    .filter((asset) => !formulaDuplicatesDeterministicAlgorithm(
      asset, retainedAlgorithmAssets, suppliedVerifiedAssets,
    ))
    .filter((asset) => !formulaCoversStructuralText(doc, asset))
    .filter((asset) => !formulaDuplicatesNumericProseTail(doc, asset))
    // An uncaptioned code proposal detached from a complete caption-anchored
    // deterministic algorithm is a proven false positive on that page.
    .filter((asset) => asset.kind !== 'code'
      || Boolean(asset.captionUnitId)
      || !deterministicAlgorithmPages.has(asset.pageIndex))
    .filter((asset) => !proseHeavyFormulaRegion(doc, asset))
    .map((asset) => extendTableThroughClippedTailLine(doc, trimTableBeforeFollowingProse(doc, {
      ...asset,
      rect: { ...asset.rect },
    })))
    .concat(retainedAlgorithmAssets);
  // Recover a wrapped caption before any verified crop is allowed to mask its
  // glyphs. Some Vision boxes begin through the last caption baseline; doing
  // this only after asset masking loses the continuation irreversibly.
  units = repairCaptionContinuationBeforeImmutableTable(
    units, regions, verifiedAssetRegions, blocks,
  );
  // Capture table descriptions while every parser caption is still present.
  // Later bibliography reconstruction may temporarily replace units whose PDF
  // extraction order trails the References heading even when their physical
  // table floats above it. Keep the enriched source so a restored caption does
  // not regress to a bare "TABLE N" label.
  units = attachTableCaptionDescriptions(units, regions, verifiedAssetRegions, blocks);
  const enrichedTableCaptionSources = new Map(units.flatMap((unit) => (
    unit.sourceText && isTableCaptionText(unit.sourceText)
      ? [[unit.id, unit.sourceText] as const]
      : []
  )));
  // Clamp before any coordinate-based text masking so a coarse table box
  // cannot delete the first glyphs of the neighbouring prose column.
  clampOverlappingSiblingAssets(doc, verifiedAssetRegions);
  verifiedAssetRegions.forEach((asset) => {
    clampSpanFigureToCaptionColumn(doc, asset);
    clampColumnTableToGutter(doc, asset);
    extendFigureThroughPrecedingVisualLabels(doc, asset, verifiedAssetRegions);
  });
  // PDF.js can aggregate an entire diagram's labels with its trailing caption.
  // When reconciliation binds that block as the caption owner, translate only
  // the actual caption lines; the verified asset retains the preceding labels.
  const captionAssetCounts = new Map<string, number>();
  for (const asset of verifiedAssetRegions) {
    if (asset.captionUnitId) {
      captionAssetCounts.set(asset.captionUnitId, (captionAssetCounts.get(asset.captionUnitId) ?? 0) + 1);
    }
  }
  for (const asset of verifiedAssetRegions) {
    if (!asset.captionUnitId || (asset.kind !== 'figure' && asset.kind !== 'table')) continue;
    if (captionAssetCounts.get(asset.captionUnitId) !== 1) continue;
    const unit = units.find((candidate) => candidate.id === asset.captionUnitId);
    const block = blocks.get(asset.captionUnitId);
    const caption = block ? embeddedCaptionText(block.text ?? '', asset.kind) : undefined;
    if (!unit || !caption) continue;
    if (unit.kind === 'paragraph' || unit.kind === 'list-item') {
      unit.kind = asset.kind === 'table' ? 'table-title' : 'caption';
    }
    unit.sourceText = caption;
    unit.protectedTokens = extractProtectedTokens(caption);
  }
  const verifiedCaptionIds = new Set(verifiedAssetRegions
    .map((asset) => asset.captionUnitId)
    .filter((id): id is string => Boolean(id)));
  const portraitPages = authorPortraitPages(doc, verifiedAssetRegions);
  for (const region of regions) {
    const visionLayout = options.pageLayouts?.get(region.sourcePage);
    if (visionLayout === 'single' && !portraitPages.has(region.sourcePage)) region.mode = 'single';
    else if (visionLayout === 'double' && region.mode !== 'full-width') region.mode = 'double';
  }
  const furnitureIds = detectedPageFurnitureIds(doc);
  const repeatedFurnitureLines = repeatedEmbeddedFurnitureLines(doc);
  const nestedFragmentIds = nestedPdfFragmentIds(doc);
  if (nestedFragmentIds.size) {
    units = units.filter((unit) => !nestedFragmentIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !nestedFragmentIds.has(unitId));
    }
  }
  const formulaFragmentIds = new Set(doc.blocks
    .filter((block) => verifiedAssetRegions.some((asset) => isFormulaExtractionFragment(block, asset)))
    .map((block) => block.id));
  if (formulaFragmentIds.size) {
    units = units.filter((unit) => !formulaFragmentIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !formulaFragmentIds.has(unitId));
    }
  }
  if (furnitureIds.size) {
    units = units.filter((unit) => !furnitureIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !furnitureIds.has(unitId));
    }
  }

  separateOverlappingArxivMetadata(doc, units);
  const emptiedFurnitureIds = new Set<string>();
  for (const unit of units) {
    if (!unit.sourceText) continue;
    const block = blocks.get(unit.id);
    if (!block) continue;
    // Apply the coordinate mask while source offsets still refer to the raw
    // PDF text.  Later cleaners can remove or rearrange lines, after which a
    // sourceIndex can no longer be mapped back reliably.
    const assetCleaned = withoutAssetTextLines(
      block,
      unit.sourceText,
      verifiedAssetRegions.filter((asset) => asset.captionUnitId !== unit.id
        && !fontFormulas.some((formula) => formula.id === asset.id)),
    );
    // A legitimate first-page title often straddles the generic 10% top
    // margin threshold. Never treat its first visual line as running furniture.
    const geometryCleaned = ['title', 'author'].includes(unit.kind)
      ? assetCleaned
      : withoutEmbeddedMarginFurniture(doc, block, assetCleaned);
    const labelsCleaned = withoutDetachedVariableLines(normalizeDetachedSubscriptLines(
      withoutTrailingVisualLabelCluster(geometryCleaned),
    ));
    const crossesPages = new Set((block.fragments ?? []).map((fragment) => fragment.pageIndex)).size > 1;
    // A numbered heading can sit next to a display formula, but its leading
    // section number is structural content rather than a scattered math
    // fragment (for example, `2.4 Sparse Matrix`). Never run the heuristic
    // formula-line scrubber over headings, otherwise the number is silently
    // removed before it can be protected and translated.
    const fragmentedMathAroundProse = ['paragraph', 'abstract', 'list-item'].includes(unit.kind)
      && hasScatteredMathLinesAroundProse(labelsCleaned);
    const fragmentsCleaned = unit.kind !== 'heading'
      && (crossesPages || block.rect.h <= 24 || nearVerifiedFormula(block, verifiedAssetRegions)
        || fragmentedMathAroundProse)
      ? withoutScatteredMathLines(labelsCleaned)
      : labelsCleaned;
    const furnitureCleaned = withoutRepeatedEmbeddedFurniture(
      doc,
      block,
      fragmentsCleaned,
      repeatedFurnitureLines,
    );
    const cleaned = withoutPublisherBoilerplate(furnitureCleaned);
    if (cleaned !== unit.sourceText) {
      unit.sourceText = cleaned;
      unit.protectedTokens = extractProtectedTokens(cleaned);
      if (!cleaned) emptiedFurnitureIds.add(unit.id);
    }
  }
  if (emptiedFurnitureIds.size) {
    units = units.filter((unit) => !emptiedFurnitureIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !emptiedFurnitureIds.has(unitId));
    }
  }

  // PDF.js occasionally classifies a display equation as one or more tiny
  // paragraph blocks, especially when stacked limits are emitted after the
  // operator. Translating those fragments separately produces incomplete
  // formulas such as two detached summation signs. Reclassify only compact,
  // prose-free mathematical blocks; the formula cluster pass below then
  // reconstructs the original visual row from their character geometry.
  const reclassifiedFormulaSources = new Map<string, string>();
  for (const unit of units) {
    const block = blocks.get(unit.sourceBlockId ?? unit.id);
    if (!isStandaloneFormulaParagraph(unit, block)) continue;
    reclassifiedFormulaSources.set(unit.id, unit.sourceText!);
    unit.kind = 'formula';
    unit.sourceText = undefined;
    unit.protectedTokens = [];
    unit.assetId = unit.id;
  }

  const bibliographySectionIds = new Set(units
    .filter((unit) => unit.kind === 'heading' && isBibliographyHeading(unit.sourceText))
    .map((unit) => unit.id));
  if (bibliographySectionIds.size) {
    units = units.map((unit) => unit.id !== unit.parentId && bibliographySectionIds.has(unit.parentId ?? '')
      && authorBiographyStart(unit.sourceText) === undefined
      ? { ...unit, kind: 'reference' as const }
      : unit);
  }

  // A body sentence can continue on a new PDF text line with a citation such
  // as `[34] as the basic building block ...`. The line classifier sees the
  // leading bracket and labels it as a bibliography entry even though it is
  // still ordinary prose. Real bibliography units are parented to the
  // References heading; recover only unparented, sentence-like false matches.
  const firstBibliographyHeadingOrder = units
    .filter((unit) => unit.kind === 'heading' && isBibliographyHeading(unit.sourceText))
    .map((unit) => blocks.get(unit.sourceBlockId ?? unit.id)?.order ?? unit.order)
    .sort((left, right) => left - right)[0];
  units = units.map((unit) => {
    if (unit.kind !== 'reference' || !unit.sourceText) return unit;
    const physicalOrder = blocks.get(unit.sourceBlockId ?? unit.id)?.order ?? unit.order;
    if (firstBibliographyHeadingOrder !== undefined && physicalOrder < firstBibliographyHeadingOrder) {
      return { ...unit, kind: 'paragraph' as const };
    }
    if (unit.parentId) return unit;
    const wordsAfterCitation = unit.sourceText
      .replace(/^\s*\[\d+\]\s*/, '')
      .match(/[A-Za-z]{3,}/g)?.length ?? 0;
    return wordsAfterCitation >= 5 ? { ...unit, kind: 'paragraph' as const } : unit;
  });

  units = rebuildBibliographyFromGeometry(doc, units, regions, blocks);

  // PDF text extraction can merge adjacent captions from multiple visual
  // objects into one block (for example Figure 9 + Figure 10, or Figure 9 +
  // Table 2). Keep the crops separate and create one semantic caption per
  // visual object, preserving the source left-to-right order within each kind.
  const assetsByCaption = new Map<string, DetectedAssetRegion[]>();
  for (const asset of verifiedAssetRegions) {
    if (!asset.captionUnitId) continue;
    const group = assetsByCaption.get(asset.captionUnitId) ?? [];
    group.push(asset);
    assetsByCaption.set(asset.captionUnitId, group);
  }
  for (const [captionId, assets] of assetsByCaption) {
    const original = units.find((unit) => unit.id === captionId);
    if (!original?.sourceText) continue;
    const segments = splitMergedCaptionText(original.sourceText);
    if (segments.length < 2) continue;
    const supportedAssets = assets.filter((asset) => asset.kind === 'figure' || asset.kind === 'table');
    const countsMatch = supportedAssets.length === assets.length
      && (['figure', 'table'] as const).every((kind) => (
        supportedAssets.filter((asset) => asset.kind === kind).length
        === segments.filter((segment) => segment.kind === kind).length
      ));
    if (!countsMatch) continue;

    const segmentTotals = new Map<'figure' | 'table', number>();
    const segmentOrdinals = new Map<'figure' | 'table', number>();
    for (const kind of ['figure', 'table'] as const) {
      segmentTotals.set(kind, segments.filter((segment) => segment.kind === kind).length);
    }
    const replacements: SemanticUnit[] = segments.map((segment, index) => {
      const ordinal = (segmentOrdinals.get(segment.kind) ?? 0) + 1;
      segmentOrdinals.set(segment.kind, ordinal);
      const suffix = (segmentTotals.get(segment.kind) ?? 0) > 1
        ? `${segment.kind}-${ordinal}`
        : segment.kind;
      return {
        ...original,
        id: `${captionId}-${suffix}`,
        kind: segment.kind === 'table' ? 'table-title' : 'caption',
        sourceText: segment.text,
        protectedTokens: extractProtectedTokens(segment.text),
        order: original.order + (index - (segments.length - 1) / 2) * 0.01,
      };
    });
    units = units.filter((unit) => unit.id !== captionId).concat(replacements);
    for (const region of regions) {
      const index = region.orderedUnitIds.indexOf(captionId);
      if (index >= 0) region.orderedUnitIds.splice(index, 1, ...replacements.map((unit) => unit.id));
    }
    for (const kind of ['figure', 'table'] as const) {
      const kindAssets = supportedAssets
        .filter((asset) => asset.kind === kind)
        .sort((left, right) => left.rect.x - right.rect.x || left.rect.y - right.rect.y);
      const kindReplacements = replacements.filter((replacement) => (
        replacement.kind === (kind === 'table' ? 'table-title' : 'caption')
      ));
      kindAssets.forEach((asset, index) => {
        asset.captionUnitId = kindReplacements[index]!.id;
      });
    }
  }

  for (const asset of verifiedAssetRegions) {
    if (asset.kind !== 'table') continue;
    const assetBottom = asset.rect.y + asset.rect.h;
    const caption = asset.captionUnitId ? blocks.get(asset.captionUnitId) : undefined;
    const captionBottom = caption ? caption.rect.y + caption.rect.h : undefined;
    const attachedBodyIds = new Set<string>();
    const numericRows = doc.blocks.filter((block) => {
      if (block.pageIndex !== asset.pageIndex || block.id === asset.captionUnitId) return false;
      const horizontalOverlap = Math.max(0, Math.min(
        block.rect.x + block.rect.w,
        asset.rect.x + asset.rect.w,
      ) - Math.max(block.rect.x, asset.rect.x));
      const overlap = Math.max(0, Math.min(
        block.rect.y + block.rect.h,
        asset.rect.y + asset.rect.h,
      ) - Math.max(block.rect.y, asset.rect.y));
      const numericTokens = block.text?.match(/\d+(?:[.,]\d+)?/g) ?? [];
      const lines = (block.text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const attachedCaptionBody = captionBottom !== undefined
        && block.rect.y >= captionBottom - 1
        // A spanning table is often split into two tall PDF text aggregates.
        // Their bounding boxes begin at the first cell baseline rather than
        // immediately below the caption, so a fixed one-line tolerance can
        // miss the whole upper half of the table. The candidate must still be
        // multi-line and numeric-dense below, which keeps ordinary prose out.
        && block.rect.y <= captionBottom + Math.max(20, Math.min(32, block.rect.h * 0.6))
        && lines.length >= 4
        && numericTokens.length >= 4;
      if (attachedCaptionBody) attachedBodyIds.add(block.id);
      const visuallyContinuousLabels = block.rect.y <= assetBottom + 4
        && block.rect.y + block.rect.h > asset.rect.y
        && looksLikeVisualLabels(block);
      return horizontalOverlap / Math.max(1, Math.min(block.rect.w, asset.rect.w)) >= 0.2
        && (overlap / Math.max(1, block.rect.h) >= 0.6 || visuallyContinuousLabels || attachedCaptionBody)
        && numericTokens.length >= 2;
    });
    if (!numericRows.length) continue;
    const left = Math.min(asset.rect.x, ...numericRows.map((block) => block.rect.x));
    const right = Math.max(asset.rect.x + asset.rect.w, ...numericRows.map((block) => block.rect.x + block.rect.w));
    const numericBottom = Math.max(...numericRows.map((block) => block.rect.y + block.rect.h)) + 2;
    const extendsThroughVisualLabels = numericRows.some((block) => (
      block.rect.y <= assetBottom + 4
      && block.rect.y + block.rect.h > assetBottom + 2
      && looksLikeVisualLabels(block)
    ));
    const bottom = extendsThroughVisualLabels || attachedBodyIds.size > 0
      ? Math.max(assetBottom, numericBottom)
      : Math.min(assetBottom, numericBottom);
    const rowsCrossingTop = numericRows.filter((block) => (
      !(attachedBodyIds.has(block.id) && tableCaptionDescription(block, asset.pageIndex))
      &&
      block.rect.y < asset.rect.y
      && block.rect.y + block.rect.h > asset.rect.y
    ));
    const top = Math.min(
      asset.rect.y,
      ...rowsCrossingTop.map((block) => block.rect.y - 2),
      ...numericRows
        .filter((block) => attachedBodyIds.has(block.id))
        .map((block) => {
          const description = tableCaptionDescription(block, asset.pageIndex);
          return Math.max(captionBottom! + 2, description ? description.bottom + 3 : block.rect.y - 2);
        }),
    );
    asset.rect = {
      ...asset.rect,
      x: left,
      y: top,
      w: right - left,
      h: bottom > top + 12 ? bottom - top : asset.rect.h,
    };
  }

  // A coarse Vision box for a column table can leak a narrow strip from the
  // neighbouring prose column. Clamp only clearly column-sized tables to the
  // gutter; genuinely spanning tables keep their full width classification.
  verifiedAssetRegions.forEach((asset) => clampColumnTableToGutter(doc, asset));

  // A PDF text block can contain translatable prose around one or more inline
  // formulas. Preserve each expression as source pixels and keep the prose as
  // independent translation units around it. PDF.js frequently classifies the
  // whole paragraph as prose even when subscripts and large operators are
  // emitted out of reading order, so geometry (not only block type) is the
  // deciding evidence here.
  for (const unit of [...units]) {
    if (!['formula', 'paragraph', 'abstract', 'list-item'].includes(unit.kind)
      || (!isNaturalLanguageFormulaBlock(unit.sourceText)
        && !(fontFormulas.length && (unit.sourceText?.match(/[A-Za-z]{3,}/g)?.length ?? 0) >= 2))) continue;
    const block = blocks.get(unit.id);
    if (!block?.characterRects?.length || !unit.sourceText) continue;
    if (verifiedAssetRegions.some((asset) => materiallyCovered(block, asset))) continue;
    const fragments: Array<InlineFormulaFragment & { absoluteStart: number; absoluteEnd: number }> = [];
    for (const formula of fontFormulas) {
      if (formula.pageIndex !== block.pageIndex || !verifiedAssetRegions.includes(formula)
        && !verifiedAssetRegions.some((asset) => asset.id === formula.id)) continue;
      const selected = block.characterRects.filter((character) => formula.sourceCharacterRanges.some((range) => (
        range.blockId === block.id && character.sourceIndex >= range.start && character.sourceIndex < range.end
      )));
      if (!selected.length) continue;
      const spans: Array<{ start: number; end: number }> = [];
      for (const character of [...selected].sort((left, right) => left.sourceIndex - right.sourceIndex)) {
        const last = spans.at(-1);
        if (last && !(block.text ?? '').slice(last.end, character.sourceIndex).trim()) {
          last.end = character.sourceIndex + character.ch.length;
        } else spans.push({ start: character.sourceIndex, end: character.sourceIndex + character.ch.length });
      }
      const largest = spans.sort((left, right) => right.end - right.start - (left.end - left.start))[0]!;
      const { start, end } = largest;
      const sourceSlice = (block.text ?? '').slice(start, end).trim();
      const raw = [sourceSlice, withoutDetachedVariableLines(normalizeDetachedSubscriptLines(sourceSlice)).trim()]
        .find((candidate) => candidate.length >= 1 && unit.sourceText!.includes(candidate)) ?? '';
      if (!raw || (raw.match(/[A-Za-z]{3,}/g) ?? []).length > 1) continue;
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = raw.length < 3 ? `(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])` : escaped;
      const originalMatches = [...(block.text ?? '').matchAll(new RegExp(pattern, 'g'))];
      const matches = [...unit.sourceText.matchAll(new RegExp(pattern, 'g'))];
      const ordinal = originalMatches.findIndex((match) => match.index! >= start && match.index! < end);
      if (!matches.length || (matches.length > 1 && (ordinal < 0 || matches.length !== originalMatches.length))) continue;
      const absoluteStart = matches[matches.length === 1 ? 0 : ordinal]?.index ?? -1;
      if (!raw || absoluteStart < 0) continue;
      const absoluteEnd = absoluteStart + raw.length;
      if (fragments.some((fragment) => absoluteStart < fragment.absoluteEnd && absoluteEnd > fragment.absoluteStart)) continue;
      fragments.push({ start: absoluteStart, end: absoluteEnd, absoluteStart, absoluteEnd,
        before: unit.sourceText.slice(0, absoluteStart), after: unit.sourceText.slice(absoluteEnd),
        pageIndex: formula.pageIndex, rect: formula.rect });
      const verifiedIndex = verifiedAssetRegions.findIndex((asset) => asset.id === formula.id);
      if (verifiedIndex >= 0) verifiedAssetRegions.splice(verifiedIndex, 1);
    }
    fragments.sort((left, right) => left.absoluteStart - right.absoluteStart);
    const hasFontFragments = fragments.length > 0;
    let consumed = 0;
    while (!hasFontFragments && consumed < unit.sourceText.length && fragments.length < 8) {
      const remainder = unit.sourceText.slice(consumed);
      const fragment = inlineFormulaFragment(block, remainder);
      if (!fragment) break;
      const absoluteStart = consumed + fragment.start;
      const absoluteEnd = consumed + fragment.end;
      if (absoluteEnd <= absoluteStart || absoluteEnd <= consumed) break;
      const page = doc.pages[fragment.pageIndex];
      const intersecting = doc.blocks.filter((candidate) => (
        candidate.pageIndex === fragment.pageIndex
        && intersectionArea(candidate.rect, fragment.rect) > 0
      ));
      const candidateAsset: DetectedAssetRegion = {
        id: `${unit.id}-inline-candidate`,
        kind: 'formula',
        pageIndex: fragment.pageIndex,
        rect: fragment.rect,
        widthMode: block.widthMode,
      };
      if (page && validateImmutableRegion(candidateAsset, page, intersecting).issues.includes('body-prose-density')) {
        // A malformed PDF source index can make a short `x = ...` match span
        // most of the prose line. Keep that source text translatable and keep
        // scanning for a later, genuinely tight expression.
        consumed = absoluteEnd;
        continue;
      }
      fragments.push({ ...fragment, absoluteStart, absoluteEnd });
      consumed = absoluteEnd;
    }
    if (!fragments.length) continue;

    const previousUnit = [...units]
      .filter((candidate) => candidate.order < unit.order && Boolean(candidate.sourceText))
      .sort((left, right) => right.order - left.order)
      .find((candidate) => {
        const candidateBlock = blocks.get(candidate.sourceBlockId ?? candidate.id);
        return candidateBlock
          && candidateBlock.pageIndex === block.pageIndex
          && sameVisualColumn(candidateBlock, block, doc.pages[block.pageIndex]?.width ?? doc.meta.paperWidth);
      });
    const previousBlock = previousUnit ? blocks.get(previousUnit.sourceBlockId ?? previousUnit.id) : undefined;
    if (previousUnit?.sourceText && previousBlock) {
      const cleanedPrevious = withoutTrailingFormulaFragment(previousUnit.sourceText);
      if (cleanedPrevious.length < previousUnit.sourceText.trim().length) {
        // The detached text-layer symbol can share a bounding row with the
        // preceding prose even though the visible operator is already inside
        // the tight inline-formula crop. Remove the duplicate source text but
        // do not enlarge the crop into that prose baseline.
        previousUnit.sourceText = cleanedPrevious;
        previousUnit.protectedTokens = extractProtectedTokens(cleanedPrevious);
      }
    }

    const replacementUnits: SemanticUnit[] = [];
    let cursor = 0;
    const pushText = (text: string, id: string) => {
      const cleaned = withoutDetachedVariableLines(text)
        .trim().replace(/^[,;:]\s*/, '').replace(/[,;:]\s*$/, '');
      if (!cleaned) return;
      replacementUnits.push({
        ...unit,
        id,
        kind: unit.kind === 'formula' ? 'paragraph' : unit.kind,
        sourceText: cleaned,
        protectedTokens: extractProtectedTokens(cleaned),
        order: unit.order + replacementUnits.length * 0.0001,
        assetId: undefined,
      });
    };
    for (const [index, fragment] of fragments.entries()) {
      const textId = index === 0
        ? `${unit.id}-inline-before`
        : `${unit.id}-inline-between-${index}`;
      pushText(unit.sourceText.slice(cursor, fragment.absoluteStart), textId);
      const assetId = index === 0
        ? `${unit.id}-inline-formula`
        : `${unit.id}-inline-formula-${index + 1}`;
      const overlappingPrevious = assetRegions
        .filter((asset) => (
          asset.kind === 'formula'
          && asset.pageIndex === fragment.pageIndex
          && asset.id.includes('-inline-formula')
          && !asset.id.startsWith(`${unit.id}-`)
        ))
        .sort((left, right) => right.rect.y - left.rect.y)
        .find((asset) => {
          const ownerId = asset.id.match(/^(.*)-inline-formula(?:-\d+)?$/)?.[1];
          const ownerBlock = ownerId ? blocks.get(ownerId) : undefined;
          const horizontalGap = Math.max(
            0,
            asset.rect.x - (fragment.rect.x + fragment.rect.w),
            fragment.rect.x - (asset.rect.x + asset.rect.w),
          );
          const verticalGap = Math.max(
            0,
            asset.rect.y - (fragment.rect.y + fragment.rect.h),
            fragment.rect.y - (asset.rect.y + asset.rect.h),
          );
          // Adjacent equation baselines can touch because a summation's limits
          // make the earlier crop tall. They are not duplicate extractions.
          // Only fold into another inline asset when both source blocks occupy
          // effectively the same visual row.
          return horizontalGap <= 12
            && verticalGap <= 2
            && (!ownerBlock || Math.abs(ownerBlock.rect.y - block.rect.y) <= 8);
        });
      if (overlappingPrevious) {
        // The later block is a duplicate limit/subscript extraction from the
        // same visual formula. Its rectangle can also span surrounding prose,
        // so retain the earlier tight crop instead of taking their union.
        const fragmentSource = unit.sourceText.slice(fragment.absoluteStart, fragment.absoluteEnd);
        const baseVariable = (fragmentSource.match(/\b[A-Za-z]\b/g) ?? [])
          .filter((candidate) => !/^[ij]$/i.test(candidate))
          .at(-1);
        const precedingText = replacementUnits.at(-1);
        if (baseVariable && precedingText?.sourceText) {
          precedingText.sourceText = `${precedingText.sourceText} ${baseVariable}`;
          precedingText.protectedTokens = extractProtectedTokens(precedingText.sourceText);
        }
        cursor = fragment.absoluteEnd;
        continue;
      }
      replacementUnits.push({
        ...unit,
        id: assetId,
        kind: 'formula',
        sourceText: undefined,
        protectedTokens: [],
        assetId,
        order: unit.order + replacementUnits.length * 0.0001,
      });
      assetRegions.push({
        id: assetId,
        kind: 'formula',
        pageIndex: fragment.pageIndex,
        rect: fragment.rect,
        widthMode: block.widthMode,
        formulaHint: unit.sourceText.slice(fragment.absoluteStart, fragment.absoluteEnd),
        ...(() => {
          const exact = fontFormulas.find((formula) => formula.rect === fragment.rect);
          return exact ? { geometrySource: exact.geometrySource, preserveRects: exact.preserveRects, sourceCharacterRanges: exact.sourceCharacterRanges, formulaHint: exact.formulaHint,
            requiresLargeOperator: exact.requiresLargeOperator } : {};
        })(),
      });
      cursor = fragment.absoluteEnd;
    }
    pushText(unit.sourceText.slice(cursor), `${unit.id}-inline-after`);
    const unitIndex = units.indexOf(unit);
    units.splice(unitIndex, 1, ...replacementUnits);
    const region = regions.find((candidate) => candidate.id === unit.layoutRegionId);
    const regionIndex = region?.orderedUnitIds.indexOf(unit.id) ?? -1;
    if (region && regionIndex >= 0) {
      region.orderedUnitIds.splice(regionIndex, 1, ...replacementUnits.map((candidate) => candidate.id));
    }
  }

  recoverOperatorInlineFormulas(doc, units, regions, blocks, assetRegions, fontFormulas);

  // Some detached limit blocks are removed from semantic reading order before
  // they can become formula units. Recover their character geometry directly
  // against the tight inline assets. Assign every glyph to its nearest sibling
  // formula so two equations on adjacent baselines cannot absorb one another.
  const inlineFormulaAssets = assetRegions.filter((asset) => (
    asset.kind === 'formula' && /-inline-formula(?:-\d+)?$/.test(asset.id)
  ));
  const detachedFormulaCandidates = doc.blocks.flatMap((fragmentBlock) => {
    const text = fragmentBlock.text?.trim() ?? '';
    const glyphs = detachedFormulaGlyphs(fragmentBlock, fragmentBlock.pageIndex);
    if (!glyphs.length) return [];
    const page = doc.pages[fragmentBlock.pageIndex];
    if (!page) return [];
    const fragmentRect = unionRects(glyphs.map((character) => character.rect));
    if (!fragmentRect) return [];
    const nearbyAssets = inlineFormulaAssets.filter((asset) => {
      if (asset.pageIndex !== fragmentBlock.pageIndex) return false;
      const horizontalGap = Math.max(
        0,
        fragmentRect.x - (asset.rect.x + asset.rect.w),
        asset.rect.x - (fragmentRect.x + fragmentRect.w),
      );
      const verticalGap = Math.max(
        0,
        fragmentRect.y - (asset.rect.y + asset.rect.h),
        asset.rect.y - (fragmentRect.y + fragmentRect.h),
      );
      return horizontalGap <= 8 && verticalGap <= 8;
    });
    return nearbyAssets.length ? [{ fragmentBlock, page, fragmentRect, nearbyAssets, text, glyphs }] : [];
  });
  for (const candidate of detachedFormulaCandidates) {
    const { fragmentBlock, page, nearbyAssets, text, glyphs } = candidate;
    const sharedCompanion = detachedFormulaCandidates.some((other) => (
      other.fragmentBlock.id !== fragmentBlock.id
      && other.fragmentBlock.pageIndex === fragmentBlock.pageIndex
      && other.nearbyAssets.some((asset) => nearbyAssets.some((current) => current.id === asset.id))
      && (
        (/[∑∫∏]/u.test(text) && /=/u.test(other.text))
        || (/=/u.test(text) && /[∑∫∏]/u.test(other.text))
      )
    ));
    // A lone extracted summation near one inline equation is ambiguous: it can
    // belong to a different line in the same aggregate paragraph. Require one
    // block spanning multiple tight formulas, or a sum/operator block paired
    // with a separate equality/index block at the same formula.
    if (nearbyAssets.length < 2 && !sharedCompanion) continue;
    nearbyAssets.forEach((asset) => (
      absorbDetachedFormulaGlyphs(asset, nearbyAssets, glyphs, page)
    ));
  }

  // Display formulas are often emitted by PDF.js as one small equation anchor
  // plus several late, out-of-order text blocks for limits and subscripts.
  // Reconstruct the visual row from character geometry and remove those
  // duplicate text-layer fragments before pagination.
  const clusteredFormulaRects = new Map<string, Rect>();
  const clusteredFormulaFragmentIds = new Set<string>();
  const clusteredFormulaPrefixIds = new Set<string>();
  const currentUnitIds = new Set(units.map((unit) => unit.id));
  const discardedEmbeddedFormulaIds = new Set<string>();
  for (const unit of units) {
    if (unit.kind !== 'formula' || clusteredFormulaFragmentIds.has(unit.id)) continue;
    const block = blocks.get(unit.id);
    if (!block || verifiedAssetRegions.some((asset) => materiallyCovered(block, asset))) continue;
    const cluster = formulaGlyphCluster(doc, block, currentUnitIds);
    if (!cluster) continue;
    clusteredFormulaRects.set(unit.id, cluster.rect);
    cluster.fragmentIds.forEach((id) => clusteredFormulaFragmentIds.add(id));
    cluster.prefixIds.forEach((id) => clusteredFormulaPrefixIds.add(id));
  }
  if (clusteredFormulaFragmentIds.size) {
    units = units.filter((unit) => !clusteredFormulaFragmentIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((id) => !clusteredFormulaFragmentIds.has(id));
    }
  }
  for (const prefixId of clusteredFormulaPrefixIds) {
    const prefixUnit = units.find((unit) => unit.id === prefixId);
    if (!prefixUnit?.sourceText) continue;
    prefixUnit.sourceText = withoutLeadingFormulaLines(prefixUnit.sourceText);
    prefixUnit.protectedTokens = extractProtectedTokens(prefixUnit.sourceText);
  }

  for (const unit of units) {
    if (unit.kind !== 'formula' && unit.kind !== 'code' && unit.kind !== 'page-furniture') continue;
    if (unit.assetId && assetRegions.some((asset) => asset.id === unit.assetId)) continue;
    const block = blocks.get(unit.id);
    if (!block) throw new Error(`不可变资产 ${unit.id} 缺少源坐标`);
    if (verifiedAssetRegions.some((asset) => materiallyCovered(block, asset))) continue;
    if (unit.kind === 'formula' && isNaturalLanguageFormulaBlock(unit.sourceText)) {
      unit.kind = 'paragraph';
      delete unit.assetId;
      continue;
    }
    let rect = unit.kind === 'formula'
      ? clusteredFormulaRects.get(unit.id) ?? doc.blocks
        .filter((candidate) => formulaContinuation(block, candidate))
        .reduce((combined, candidate) => unionRect(combined, candidate.rect), { ...block.rect })
      : { ...block.rect };
    let previousToClean: SemanticUnit | undefined;
    let cleanedPrevious: string | undefined;
    if (unit.kind === 'formula') {
      const pageWidth = doc.pages[block.pageIndex]?.width ?? doc.meta.paperWidth;
      const previousBlock = doc.blocks
        .filter((candidate) => (
          candidate.id !== block.id
          && candidate.pageIndex === block.pageIndex
          && sameVisualColumn(candidate, block, pageWidth)
          && candidate.rect.y + candidate.rect.h <= block.rect.y + 2
          && block.rect.y - (candidate.rect.y + candidate.rect.h) <= 24
        ))
        .sort((left, right) => (
          right.rect.y + right.rect.h - (left.rect.y + left.rect.h)
        ))[0];
      const previous = previousBlock
        ? units.find((candidate) => candidate.id === previousBlock.id)
        : undefined;
      if (previous?.sourceText && previousBlock) {
        const cleaned = withoutTrailingFormulaFragment(previous.sourceText);
        const formulaTail = cleaned.length < previous.sourceText.trim().length
          ? trailingFormulaRect(previousBlock, cleaned.length)
          : undefined;
        if (formulaTail) rect = unionRect(rect, formulaTail);
        previousToClean = previous;
        cleanedPrevious = cleaned;
      }
    }
    const candidateAsset: DetectedAssetRegion = {
      id: unit.assetId ?? unit.id,
      kind: unit.kind,
      pageIndex: block.pageIndex,
      rect,
      widthMode: block.widthMode,
    };
    if (unit.kind === 'formula') {
      // A detached PDF text item can mix limits from two different formulas.
      // Its coarse box need not overlap either crop enough to be a duplicate;
      // check every mapped glyph against the union of existing formula masks.
      const visibleGlyphs = block.characterRects?.filter((character) => character.ch.trim()) ?? [];
      const sourceGlyphCount = (block.text ?? '').replace(/\s+/g, '').length;
      const mappedGlyphCount = visibleGlyphs.reduce((count, character) => count + character.ch.replace(/\s+/g, '').length, 0);
      if (visibleGlyphs.length && mappedGlyphCount >= sourceGlyphCount
        && visibleGlyphs.every((character) => assetRegions.some((existing) => (
          existing.kind === 'formula' && existing.pageIndex === character.pageIndex
          && assetCompositesSourceCharacter(existing, block, character)
        )))) {
        discardedEmbeddedFormulaIds.add(unit.id);
        continue;
      }
      const overlappingTightFormulas = assetRegions.filter((existing) => {
        if (existing.kind !== 'formula' || existing.pageIndex !== block.pageIndex) return false;
        const overlap = intersectionArea(existing.rect, rect);
        const existingArea = Math.max(1, existing.rect.w * existing.rect.h);
        const candidateArea = Math.max(1, rect.w * rect.h);
        return overlap / Math.min(existingArea, candidateArea) >= 0.75;
      });
      if (overlappingTightFormulas.length) {
        // Inline reconstruction already produced a tighter crop for this
        // expression. PDF.js can also emit a later disconnected aggregate
        // whose outer box spans formulas and the prose between them. Individual
        // glyph boxes from that aggregate can still safely complete detached
        // limits/subscripts without freezing its unsafe outer rectangle.
        discardedEmbeddedFormulaIds.add(unit.id);
        continue;
      }
      const page = doc.pages[block.pageIndex];
      if (!page) throw new Error(`不可变资产 ${unit.id} 缺少页面尺寸`);
      const intersecting = doc.blocks.filter((candidate) => (
        candidate.pageIndex === block.pageIndex
        && candidate.rect.x < rect.x + rect.w
        && candidate.rect.x + candidate.rect.w > rect.x
        && candidate.rect.y < rect.y + rect.h
        && candidate.rect.y + candidate.rect.h > rect.y
      ));
      const geometry = validateImmutableRegion(candidateAsset, page, intersecting);
      if (geometry.issues.includes('body-prose-density')) {
        const reclassifiedSource = reclassifiedFormulaSources.get(unit.id);
        const originalSource = reclassifiedSource ?? unit.sourceText;
        const candidateArea = Math.max(1, rect.w * rect.h);
        const embeddedInProseAggregate = reclassifiedSource !== undefined && intersecting.some((candidate) => {
          if (candidate.id === block.id) return false;
          const naturalWords = candidate.text?.match(/[A-Za-z]{3,}/g) ?? [];
          return naturalWords.length >= 8
            && candidate.rect.w * candidate.rect.h >= candidateArea * 2
            && intersectionArea(candidate.rect, rect) / candidateArea >= 0.65;
        });
        if (embeddedInProseAggregate) {
          // The compact math block is a duplicate text-layer extraction from
          // a larger prose aggregate that already carries the sentence. Its
          // disconnected bounding box crosses ordinary words, so neither
          // rendering it as text nor freezing that rectangle is safe.
          discardedEmbeddedFormulaIds.add(unit.id);
        } else if (originalSource) {
          unit.kind = 'paragraph';
          unit.sourceText = originalSource;
          unit.protectedTokens = extractProtectedTokens(originalSource ?? '');
          delete unit.assetId;
        } else {
          // Never leave a text unit without source text: it cannot generate a
          // translation request and would fail later during composition.
          discardedEmbeddedFormulaIds.add(unit.id);
        }
        continue;
      }
    }
    assetRegions.push(candidateAsset);
    if (previousToClean && cleanedPrevious !== undefined) previousToClean.sourceText = cleanedPrevious;
  }
  if (discardedEmbeddedFormulaIds.size) {
    units = units.filter((unit) => !discardedEmbeddedFormulaIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((id) => !discardedEmbeddedFormulaIds.has(id));
    }
  }

  // Parser-confirmed formula assets are constructed after the first cleanup
  // pass above. Re-run the narrow fragment test against those new assets so a
  // piecewise equation split into `formula first row + paragraph tail` cannot
  // leave its stacked subscripts, equation number, and closing brace as a
  // translated text block (for example `res / T otal / N = ...`). Never
  // remove another formula owner here; adjacent equations remain independent.
  const deterministicFormulaFragmentIds = new Set(units
    .filter((unit) => ['paragraph', 'abstract', 'list-item'].includes(unit.kind))
    .filter((unit) => {
      const block = blocks.get(unit.sourceBlockId ?? unit.id);
      if (!block) return false;
      return assetRegions.some((asset) => (
        asset.kind === 'formula'
        && asset.id !== unit.assetId
        && asset.id !== block.id
        && isFormulaExtractionFragment(block, asset)
      ));
    })
    .map((unit) => unit.id));
  if (deterministicFormulaFragmentIds.size) {
    units = units.filter((unit) => !deterministicFormulaFragmentIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds
        .filter((id) => !deterministicFormulaFragmentIds.has(id));
    }
  }

  // PDF text extraction can detach an inline cross-reference at a column
  // boundary and the semantic classifier can then mistake the tiny fragment
  // for a table caption. Rejoin only the unambiguous form: a mixed-case bare
  // `Table N.` immediately after prose ending in “shown/presented in”. Real
  // IEEE table captions use a title/header and do not complete that sentence.
  const detachedTableReferenceIds = new Set<string>();
  for (const reference of units.filter((unit) => (
    unit.kind === 'caption'
    && /^Table\s+(?:[IVXLCDM]+|\d+)\s*[.:]?$/u.test(unit.sourceText?.trim() ?? '')
  ))) {
    const referenceBlock = blocks.get(reference.id);
    const region = regions.find((candidate) => candidate.id === reference.layoutRegionId);
    const referenceIndex = region?.orderedUnitIds.indexOf(reference.id) ?? -1;
    const previousId = referenceIndex > 0 ? region!.orderedUnitIds[referenceIndex - 1] : undefined;
    const previous = previousId ? units.find((unit) => unit.id === previousId) : undefined;
    const previousBlock = previousId ? blocks.get(previousId) : undefined;
    if (
      !referenceBlock || !region || !previous || !previousBlock
      || !['paragraph', 'abstract', 'list-item'].includes(previous.kind)
      || previousBlock.pageIndex !== referenceBlock.pageIndex
      || !sameVisualColumn(previousBlock, referenceBlock, doc.pages[referenceBlock.pageIndex]?.width ?? doc.meta.paperWidth)
      || referenceBlock.rect.y - (previousBlock.rect.y + previousBlock.rect.h) < -1
      || referenceBlock.rect.y - (previousBlock.rect.y + previousBlock.rect.h) > 6
      || !/\b(?:shown|presented|summarized|reported|listed|given|provided|described)\s+in\s*$/iu.test(previous.sourceText ?? '')
    ) continue;
    previous.sourceText = `${previous.sourceText!.trimEnd()} ${reference.sourceText!.trim()}`;
    previous.protectedTokens = extractProtectedTokens(previous.sourceText);
    detachedTableReferenceIds.add(reference.id);
  }
  if (detachedTableReferenceIds.size) {
    units = units.filter((unit) => !detachedTableReferenceIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds
        .filter((id) => !detachedTableReferenceIds.has(id));
    }
  }

  for (const caption of units.filter((unit) => (
    unit.kind === 'caption'
    && isFigureCaptionText(unit.sourceText ?? '')
    && !verifiedAssetRegions.some((asset) => asset.kind === 'figure' && asset.captionUnitId === unit.id)
  ))) {
    const captionBlock = blocks.get(caption.id);
    const region = regions.find((candidate) => candidate.id === caption.layoutRegionId);
    if (!captionBlock || !region) throw new Error(`图注 ${caption.id} 缺少版式坐标`);
    const recoveredCaption = recoverSplitColumnCaption(doc, captionBlock);
    const captionAnchor = recoveredCaption?.anchor ?? captionBlock;
    if (recoveredCaption) {
      caption.sourceText = recoveredCaption.sourceText;
      caption.protectedTokens = extractProtectedTokens(recoveredCaption.sourceText);
      const continuationIds = new Set(recoveredCaption.continuationIds);
      units = units.filter((unit) => !continuationIds.has(unit.id));
      for (const candidateRegion of regions) {
        candidateRegion.orderedUnitIds = candidateRegion.orderedUnitIds
          .filter((unitId) => !continuationIds.has(unitId));
      }
    }
    const captionIndex = region.orderedUnitIds.indexOf(caption.id);
    const pageWidth = doc.pages[captionAnchor.pageIndex]?.width ?? doc.meta.paperWidth;
    const previousBlock = [...region.orderedUnitIds.slice(0, captionIndex)]
      .reverse().map((id) => blocks.get(id)).find((block) => (
        block?.pageIndex === captionAnchor.pageIndex
        && sameVisualColumn(block, captionAnchor, pageWidth)
      ));
    const bottom = captionAnchor.rect.y - 6;
    const furnitureBoundary = doc.blocks
      .filter((block) => (
        block.pageIndex === captionAnchor.pageIndex
        && furnitureIds.has(block.id)
        && block.rect.y + block.rect.h <= bottom
        && block.rect.x < captionAnchor.rect.x + captionAnchor.rect.w
        && block.rect.x + block.rect.w > captionAnchor.rect.x
      ))
      .reduce((boundary, block) => Math.max(boundary, block.rect.y + block.rect.h + 6), 0);
    const previousBoundary = previousBlock ? previousBlock.rect.y + previousBlock.rect.h + 6 : 0;
    const visualLabelTop = doc.blocks
      .filter((block) => (
        block.pageIndex === captionAnchor.pageIndex
        && block.id !== caption.id
        && block.rect.y < bottom
        && block.rect.x < captionAnchor.rect.x + captionAnchor.rect.w
        && block.rect.x + block.rect.w > captionAnchor.rect.x
      ))
      .flatMap((block) => {
        const clusterTop = trailingVisualLabelClusterTop(block);
        if (clusterTop !== undefined) return [clusterTop];
        return looksLikeVisualLabels(block) ? [Math.max(1, block.rect.y - 6)] : [];
      })
      .reduce((boundary, top) => Math.min(boundary, top), Number.POSITIVE_INFINITY);
    const previousColumnProseBottom = previousProseBottomInCaptionColumn(doc, captionAnchor);
    const previousTableBottom = precedingTableBodyBottom(doc, captionAnchor);
    const previousPhysicalBottom = recoveredCaption
      ? previousPhysicalContentBottom(doc, captionAnchor)
      : undefined;
    const inferredTop = Math.max(
      furnitureBoundary,
      previousColumnProseBottom !== undefined ? previousColumnProseBottom + 6 : 0,
      previousTableBottom !== undefined ? previousTableBottom + 6 : 0,
      previousPhysicalBottom !== undefined ? previousPhysicalBottom + 6 : 0,
      Number.isFinite(visualLabelTop)
        ? visualLabelTop
        : (doc.pages[captionAnchor.pageIndex]?.height ?? doc.meta.paperHeight) * 0.1,
    );
    const top = previousBlock && previousBoundary < bottom - 24
      ? Math.max(previousBoundary, inferredTop)
      : inferredTop;
    if (bottom - top < 24) {
      const previousId = previousBlock?.id ?? 'none';
      const previousText = previousBlock?.text?.replace(/\s+/g, ' ').slice(0, 48) ?? 'none';
      throw new Error(
        `无法可靠确定图 ${caption.id} 的不可变区域（前块 ${previousId}“${previousText}”，可用高度 ${Math.round(bottom - top)}pt）`,
      );
    }
    const id = `${caption.id}-asset`;
    const widthMode = captionAnchor.widthMode;
    const column = visualColumnBounds(doc, captionAnchor);
    assetRegions.push({
      id, kind: 'figure', pageIndex: captionAnchor.pageIndex,
      rect: { x: column.x, y: top, w: column.w, h: bottom - top },
      widthMode, captionUnitId: caption.id,
    });
    units.push({
      id, kind: 'figure', protectedTokens: [], assetId: id,
      layoutRegionId: caption.layoutRegionId, order: caption.order - 0.1,
    });
    region.orderedUnitIds.splice(captionIndex, 0, id);
  }

  // Bibliography reconstruction is based on PDF extraction order. A terminal
  // table float can therefore be classified as bibliography content and
  // removed even when its caption and numeric body are physically above the
  // References heading. Restore only source captions that have deterministic
  // adjacent table geometry; ordinary bibliography text cannot satisfy this
  // gate.
  const survivingUnitIds = new Set(units.map((unit) => unit.id));
  const verifiedTableCaptionIds = new Set(verifiedAssetRegions
    .filter((asset) => asset.kind === 'table' && asset.captionUnitId)
    .map((asset) => asset.captionUnitId!));
  for (const sourceCaption of doc.semanticUnits) {
    if (survivingUnitIds.has(sourceCaption.id) || verifiedTableCaptionIds.has(sourceCaption.id)) continue;
    const sourceBlockId = sourceCaption.sourceBlockId ?? sourceCaption.id;
    const hasDerivedCaption = units.some((candidate) => (
      candidate.id !== sourceCaption.id
      && candidate.sourceBlockId === sourceBlockId
      && (candidate.kind === 'caption' || candidate.kind === 'table-title')
    ));
    if (hasDerivedCaption) continue;
    const captionBlock = blocks.get(sourceBlockId);
    const sourceText = enrichedTableCaptionSources.get(sourceCaption.id) ?? sourceCaption.sourceText;
    if (!captionBlock || !sourceText || !isTableCaptionText(sourceText)) continue;
    if (captionBlock.type !== 'caption' && sourceCaption.kind !== 'caption' && sourceCaption.kind !== 'table-title') {
      continue;
    }
    if (!precedingTableGeometry(doc, captionBlock)
      && !centeredSpanningTableGeometry(doc, captionBlock)
      && !hasFollowingNumericTableBody(doc, captionBlock)) continue;
    const region = regions.find((candidate) => candidate.id === sourceCaption.layoutRegionId)
      ?? regions.find((candidate) => candidate.sourcePage === captionBlock.pageIndex);
    if (!region) continue;
    const restoredCaption: SemanticUnit = {
      ...sourceCaption,
      kind: 'caption',
      layoutRegionId: region.id,
      sourceBlockId: sourceCaption.sourceBlockId ?? captionBlock.id,
      sourceText,
      protectedTokens: extractProtectedTokens(sourceText),
    };
    units.push(restoredCaption);
    survivingUnitIds.add(restoredCaption.id);
    const insertionIndex = region.orderedUnitIds.findIndex((unitId) => {
      const unit = units.find((candidate) => candidate.id === unitId);
      const block = unit ? blocks.get(unit.sourceBlockId ?? unit.id) : undefined;
      return Boolean(block
        && block.pageIndex === captionBlock.pageIndex
        && block.rect.y > captionBlock.rect.y);
    });
    region.orderedUnitIds.splice(
      insertionIndex < 0 ? region.orderedUnitIds.length : insertionIndex,
      0,
      restoredCaption.id,
    );
  }

  for (const caption of units.filter((unit) => (
    (unit.kind === 'caption' || unit.kind === 'table-title')
    && isTableCaptionText(unit.sourceText ?? '')
    && !verifiedAssetRegions.some((asset) => asset.kind === 'table' && asset.captionUnitId === unit.id)
  ))) {
    const captionBlock = blocks.get(caption.id);
    const region = regions.find((candidate) => candidate.id === caption.layoutRegionId);
    if (!captionBlock || !region) throw new Error(`表题 ${caption.id} 缺少版式坐标`);
    const recoveredCaption = recoverColumnCaptionContinuation(doc, captionBlock);
    if (recoveredCaption) {
      caption.sourceText = recoveredCaption.sourceText;
      caption.protectedTokens = extractProtectedTokens(recoveredCaption.sourceText);
      const continuationIds = new Set(recoveredCaption.continuationIds);
      units = units.filter((unit) => !continuationIds.has(unit.id));
      for (const candidateRegion of regions) {
        candidateRegion.orderedUnitIds = candidateRegion.orderedUnitIds
          .filter((unitId) => !continuationIds.has(unitId));
      }
    }
    const pageWidth = doc.pages[captionBlock.pageIndex]?.width ?? doc.meta.paperWidth;
    const captionBottom = captionBlock.rect.y + captionBlock.rect.h;
    const bodyIds: string[] = [];
    const precedingGeometry = precedingTableGeometry(doc, captionBlock);
    const spanningGeometry = centeredSpanningTableGeometry(doc, captionBlock);
    const top = precedingGeometry?.rect.y ?? spanningGeometry?.rect.y ?? captionBottom + 6;
    let bottom: number;
    const column = precedingGeometry
      ? { x: precedingGeometry.rect.x, w: precedingGeometry.rect.w }
      : spanningGeometry
      ? { x: spanningGeometry.rect.x, w: spanningGeometry.rect.w }
      : visualColumnBounds(doc, captionBlock);
    const widthMode = spanningGeometry ? 'span' as const : captionBlock.widthMode;
    if (precedingGeometry) {
      bottom = precedingGeometry.rect.y + precedingGeometry.rect.h;
    } else if (spanningGeometry) {
      bottom = spanningGeometry.rect.y + spanningGeometry.rect.h;
      bodyIds.push(...spanningGeometry.bodyIds);
    } else {
      const following = doc.blocks
        .filter((block) => (
          block.id !== caption.id
          && block.pageIndex === captionBlock.pageIndex
          && sameVisualColumn(block, captionBlock, pageWidth)
          && block.rect.y >= captionBottom - 2
        ))
        .sort((left, right) => left.rect.y - right.rect.y || left.order - right.order);
      const first = following[0];
      if (!first) throw new Error(`无法可靠确定表 ${caption.id} 的不可变区域（缺少后续边界）`);
      const initialGap = first.rect.y - captionBottom;
      if (initialGap >= 24) {
        bottom = first.rect.y - 6;
      } else {
        if (initialGap > 20) throw new Error(`无法可靠确定表 ${caption.id} 的不可变区域（表题后间距不明确）`);
        let previousBottom = captionBottom;
        let boundaryFound = false;
        for (const candidate of following) {
          const gap = candidate.rect.y - previousBottom;
          if (bodyIds.length && (
            gap > 20
            || candidate.type === 'section'
            || candidate.type === 'caption'
            || candidate.type === 'equation'
          )) {
            boundaryFound = true;
            break;
          }
          bodyIds.push(candidate.id);
          previousBottom = Math.max(previousBottom, candidate.rect.y + candidate.rect.h);
        }
        const isolatedSpanningBody = bodyIds.length > 0
          && (captionBlock.widthMode === 'span' || region.mode === 'full-width')
          && bodyIds.every((id) => {
            const block = blocks.get(id);
            return Boolean(block && (looksLikeNumericTableBody(block) || looksLikeShortTableCellLabel(block)));
          })
          && region.orderedUnitIds.every((id) => id === caption.id || bodyIds.includes(id));
        const terminalTableBody = bodyIds.length > 0
          && bodyIds.some((id) => looksLikeNumericTableBody(blocks.get(id)!))
          && bodyIds.every((id) => {
            const block = blocks.get(id)!;
            return looksLikeNumericTableBody(block) || looksLikeShortTableCellLabel(block);
          });
        // A full-width table can own an isolated parser region that ends at
        // the last numeric row. In that case there is deliberately no
        // same-column prose boundary: the region membership itself is the
        // deterministic lower boundary.
        // At a column/page end, explicit table rows provide the lower boundary.
        // Ordinary trailing prose must still fail instead of becoming an image.
        if (!bodyIds.length || (!boundaryFound && !isolatedSpanningBody && !terminalTableBody)) {
          throw new Error(`无法可靠确定表 ${caption.id} 的不可变区域（未检测到表后边界）`);
        }
        const lastBody = blocks.get(bodyIds.at(-1)!)!;
        bottom = lastBody.rect.y + lastBody.rect.h + 6;
      }
    }
    // A full-width table can be split by PDF.js into a shallow span header and
    // a separate column-classified numeric body. Keep a valid header-height
    // seed here; the attached-table pass below expands it through the numeric
    // rows before final geometry validation. Requiring 18pt at this point
    // rejects valid two-row headers that are only about 15pt high.
    if (bottom - top < 12) throw new Error(`无法可靠确定表 ${caption.id} 的不可变区域（高度不足）`);

    const id = `${caption.id}-asset`;
    assetRegions.push({
      id, kind: 'table', pageIndex: captionBlock.pageIndex,
      rect: { x: column.x, y: top, w: column.w, h: bottom - top },
      widthMode, captionUnitId: caption.id,
    });
    units = units.filter((unit) => !bodyIds.includes(unit.id));
    for (const candidateRegion of regions) {
      candidateRegion.orderedUnitIds = candidateRegion.orderedUnitIds.filter((unitId) => !bodyIds.includes(unitId));
    }
    units.push({
      id, kind: 'table', protectedTokens: [], assetId: id,
      layoutRegionId: caption.layoutRegionId, order: caption.order + (precedingGeometry ? -0.1 : 0.1),
    });
    const captionIndex = region.orderedUnitIds.indexOf(caption.id);
    region.orderedUnitIds.splice(captionIndex + (precedingGeometry ? 0 : 1), 0, id);
  }

  for (const asset of verifiedAssetRegions) {
    let caption = asset.captionUnitId ? units.find((unit) => unit.id === asset.captionUnitId) : undefined;
    if (asset.captionUnitId && !caption) {
      const sourceCaption = doc.semanticUnits.find((unit) => (
        unit.id === asset.captionUnitId && Boolean(unit.sourceText?.trim())
      ));
      if (!sourceCaption) throw new Error(`Vision 资产 ${asset.id} 缺少图表注 ${asset.captionUnitId}`);
      // A neighbouring immutable crop can overlap a caption's PDF glyph box
      // closely enough for an earlier generic cleanup pass to remove it. The
      // source semantic caption remains authoritative, so restore it instead
      // of discarding the translated Figure/Table/Algorithm label.
      caption = {
        ...sourceCaption,
        sourceBlockId: sourceCaption.sourceBlockId
          ?? (blocks.has(sourceCaption.id) ? sourceCaption.id : undefined),
        sourceText: enrichedTableCaptionSources.get(sourceCaption.id) ?? sourceCaption.sourceText,
        protectedTokens: extractProtectedTokens(
          enrichedTableCaptionSources.get(sourceCaption.id) ?? sourceCaption.sourceText!,
        ),
      };
      units.push(caption);
      const captionRegion = regions.find((candidate) => candidate.id === caption!.layoutRegionId)
        ?? regions.find((candidate) => candidate.sourcePage === asset.pageIndex);
      if (captionRegion && !captionRegion.orderedUnitIds.includes(caption.id)) {
        captionRegion.orderedUnitIds.push(caption.id);
      }
    }
    const coveredBlocks = doc.blocks.filter((block) => block.id !== asset.captionUnitId && materiallyCovered(block, asset));
    const coveredIds = new Set(coveredBlocks.map((block) => block.id));
    verifiedCaptionIds.forEach((captionId) => coveredIds.delete(captionId));
    const coveredUnits = units.filter((unit) => coveredIds.has(unit.id));
    units = units.filter((unit) => !coveredIds.has(unit.id) && unit.id !== asset.id);
    for (const candidateRegion of regions) {
      candidateRegion.orderedUnitIds = candidateRegion.orderedUnitIds.filter((unitId) => (
        !coveredIds.has(unitId) && unitId !== asset.id
      ));
    }

    const page = doc.pages[asset.pageIndex];
    if (!page) throw new Error(`Vision 资产 ${asset.id} 缺少页面尺寸`);
    const centerX = asset.rect.x + asset.rect.w / 2;
    const centerY = asset.rect.y + asset.rect.h / 2;
    const coveredRegion = coveredUnits
      .map((unit) => regions.find((candidate) => candidate.id === unit.layoutRegionId))
      .find((candidate): candidate is LayoutRegion => Boolean(candidate));
    const memberPageRegion = regions.find((candidate) => candidate.orderedUnitIds.some((unitId) => (
      blocks.get(unitId)?.pageIndex === asset.pageIndex
    )));
    const spatialRegion = regions
      .filter((candidate) => (
        candidate.sourcePage === asset.pageIndex
        && centerX >= candidate.bounds.x - 8
        && centerX <= candidate.bounds.x + candidate.bounds.w + 8
        && centerY >= candidate.bounds.y - 24
        && centerY <= candidate.bounds.y + candidate.bounds.h + 24
      ))
      .sort((left, right) => (
        right.bounds.w * right.bounds.h - left.bounds.w * left.bounds.h
      ))[0];
    const fontSourceBlock = asset.geometrySource === 'font-runs'
      ? (asset.sourceCharacterRanges ?? []).map((range) => blocks.get(range.blockId))
        .filter((block): block is Doc['blocks'][number] => Boolean(block))
        .sort((left, right) => left.order - right.order)[0] : undefined;
    const fontSourceRegionId = fontSourceBlock
      ? doc.semanticUnits.find((unit) => unit.id === fontSourceBlock.id)?.layoutRegionId : undefined;
    const region = (caption ? regions.find((candidate) => candidate.id === caption.layoutRegionId) : undefined)
      ?? (fontSourceRegionId ? regions.find((candidate) => candidate.id === fontSourceRegionId) : undefined)
      ?? (asset.kind === 'formula' ? spatialRegion : undefined)
      ?? coveredRegion
      ?? memberPageRegion
      ?? spatialRegion
      ?? regions.find((candidate) => candidate.sourcePage === asset.pageIndex);
    if (!region) throw new Error(`Vision 资产 ${asset.id} 缺少版式区域`);

    const coveredOrder = coveredUnits.length ? Math.min(...coveredUnits.map((unit) => unit.order)) : undefined;
    const regionPhysicalUnits = region.orderedUnitIds.flatMap((unitId) => {
      const unit = units.find((candidate) => candidate.id === unitId);
      const block = blocks.get(unitId);
      const rect = block ? physicalRectOnPage(block, asset.pageIndex) : undefined;
      return unit && rect ? [{ unit, rect }] : [];
    });
    const previous = regionPhysicalUnits
      .filter((candidate) => candidate.rect.y + candidate.rect.h <= asset.rect.y + 2)
      .sort((left, right) => right.rect.y + right.rect.h - (left.rect.y + left.rect.h))[0];
    const next = regionPhysicalUnits
      .filter((candidate) => candidate.rect.y >= asset.rect.y + asset.rect.h - 2)
      .sort((left, right) => left.rect.y - right.rect.y)[0];
    const physicalOrder = previous && next
        ? (previous.unit.order + next.unit.order) / 2
        : previous
          ? previous.unit.order + 0.1
          : next
            ? next.unit.order - 0.1
            : undefined;
    const order = caption
      ? caption.order + (asset.kind === 'figure' ? -0.1 : 0.1)
      : fontSourceBlock?.order ?? physicalOrder ?? coveredOrder ?? Math.max(0, ...units.map((unit) => unit.order)) + 0.1;
    units.push({
      id: asset.id, kind: asset.kind, protectedTokens: [], assetId: asset.id,
      crossPageAssetGroupId: asset.crossPageAssetGroupId,
      layoutRegionId: region.id, order,
    });
    const captionIndex = caption ? region.orderedUnitIds.indexOf(caption.id) : -1;
    if (captionIndex >= 0) {
      region.orderedUnitIds.splice(captionIndex + (asset.kind === 'figure' ? 0 : 1), 0, asset.id);
    } else {
      const nextIndex = region.orderedUnitIds.findIndex((unitId) => {
        const unit = units.find((candidate) => candidate.id === unitId);
        return unit ? unit.order > order : false;
      });
      region.orderedUnitIds.splice(nextIndex < 0 ? region.orderedUnitIds.length : nextIndex, 0, asset.id);
    }
    assetRegions.push(asset);
  }

  // Bind table descriptions only after every verified asset has restored its
  // caption anchor. A terminal bibliography can be rebuilt from physical
  // character order before this point; on float-heavy final pages that rebuild
  // may temporarily remove table captions whose PDF extraction order follows
  // the References heading. The asset pass above restores those captions, so
  // this late binding keeps the description translatable,
  // removes it from the immutable crop, and prevents a detached prose line.
  units = attachTableCaptionDescriptions(units, regions, assetRegions, blocks);
  // Caption-only normalization above intentionally resets verified caption
  // owners to their raw PDF label before geometry-based text cleaning. Restore
  // an earlier wrapped continuation only after those cleaners have finished,
  // and only when it is a strict extension of the current caption. This keeps
  // a late, more complete recovery while preventing a Vision crop from
  // permanently swallowing a short final caption line.
  for (const [captionId, recoveredSource] of enrichedTableCaptionSources) {
    const caption = units.find((unit) => unit.id === captionId);
    if (!caption?.sourceText) continue;
    const currentKey = caption.sourceText.replace(/\s+/g, '').toLocaleUpperCase();
    const recoveredKey = recoveredSource.replace(/\s+/g, '').toLocaleUpperCase();
    if (recoveredKey.length <= currentKey.length || !recoveredKey.includes(currentKey)) continue;
    caption.sourceText = recoveredSource;
    caption.protectedTokens = extractProtectedTokens(recoveredSource);
  }

  // Caption-derived table crops can be bounded from only one parser column
  // even when the physical table spans both columns. Extend a shallow crop
  // through an attached block of short labels/numeric cells before applying
  // the final text mask. Natural-language paragraphs do not satisfy the
  // visual-label predicate, so they remain outside the immutable region.
  for (const asset of assetRegions) {
    if (asset.kind !== 'table') continue;
    const captionDerived = !verifiedAssetRegions.includes(asset);
    const assetBottom = asset.rect.y + asset.rect.h;
    const continuations = doc.blocks.filter((block) => {
      if (block.pageIndex !== asset.pageIndex || block.id === asset.captionUnitId) return false;
      const horizontalOverlap = Math.max(0, Math.min(
        block.rect.x + block.rect.w,
        asset.rect.x + asset.rect.w,
      ) - Math.max(block.rect.x, asset.rect.x));
      const numericTokens = block.text?.match(/\d+(?:[.,]\d+)?/g) ?? [];
      return horizontalOverlap / Math.max(1, Math.min(block.rect.w, asset.rect.w)) >= 0.2
        && block.rect.y <= assetBottom + 4
        && block.rect.y + block.rect.h > assetBottom + 2
        && (looksLikeVisualLabels(block) || (captionDerived && looksLikeNumericTableBody(block)))
        && numericTokens.length >= 2;
    });
    if (!continuations.length) continue;
    const left = Math.min(asset.rect.x, ...continuations.map((block) => block.rect.x));
    const right = Math.max(
      asset.rect.x + asset.rect.w,
      ...continuations.map((block) => block.rect.x + block.rect.w),
    );
    const bottom = Math.max(
      assetBottom,
      ...continuations.map((block) => block.rect.y + block.rect.h + 2),
    );
    asset.rect = { ...asset.rect, x: left, w: right - left, h: bottom - asset.rect.y };
  }

  const emptyAfterAssetMask = new Set<string>();
  for (const unit of units) {
    if (!unit.sourceText || unit.kind === 'caption' || unit.kind === 'table-title') continue;
    const block = blocks.get(unit.id);
    if (!block) continue;
    const representedPages = new Set([
      block.pageIndex,
      ...(block.characterRects ?? []).map((character) => character.pageIndex),
    ]);
    const pageAssets = assetRegions.filter((asset) => (
      representedPages.has(asset.pageIndex)
      && asset.id !== unit.id
      && asset.captionUnitId !== unit.id
    ));
    if (!pageAssets.length) continue;
    unit.sourceText = withoutAssetTextLines(block, unit.sourceText, pageAssets);
    if (!unit.sourceText) emptyAfterAssetMask.add(unit.id);
  }
  if (emptyAfterAssetMask.size) {
    units = units.filter((unit) => !emptyAfterAssetMask.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !emptyAfterAssetMask.has(unitId));
    }
  }

  units = repairSplitTableFootnotes(units, regions, assetRegions, blocks);
  units = repairCaptionContinuationBeforeImmutableTable(units, regions, assetRegions, blocks);
  repairNestedInlineReadingOrder(doc, units, regions, blocks);
  units = repairInterruptedProseAcrossImmutableAsset(units, regions, assetRegions, blocks);
  repairAssetsBeforeBibliography(units, regions, assetRegions, blocks);

  const protectedCaptionIds = new Set(assetRegions
    .map((asset) => asset.captionUnitId)
    .filter((id): id is string => Boolean(id)));
  const assetIds = new Set(assetRegions.map((asset) => asset.id));
  const protectedAssetUnitIds = new Set(units
    .filter((unit) => unit.assetId && assetIds.has(unit.assetId))
    .map((unit) => unit.id));
  for (const asset of assetRegions) {
    const coveredIds = new Set(doc.blocks
      .filter((block) => block.id !== asset.captionUnitId && materiallyCovered(block, asset))
      .map((block) => block.id));
    protectedCaptionIds.forEach((captionId) => coveredIds.delete(captionId));
    // This pass removes duplicate text, never the owner of another image.
    protectedAssetUnitIds.forEach((unitId) => coveredIds.delete(unitId));
    if (coveredIds.size) {
      units = units.filter((unit) => unit.id === asset.id || !coveredIds.has(unit.id));
      for (const region of regions) {
        region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => (
          unitId === asset.id || !coveredIds.has(unitId)
        ));
      }
    }
    const page = doc.pages[asset.pageIndex];
    if (!page) throw new Error(`不可变资产 ${asset.id} 缺少页面尺寸`);
    const intersecting = doc.blocks.filter((block) => (
      block.pageIndex === asset.pageIndex
      && block.rect.x < asset.rect.x + asset.rect.w
      && block.rect.x + block.rect.w > asset.rect.x
      && block.rect.y < asset.rect.y + asset.rect.h
      && block.rect.y + block.rect.h > asset.rect.y
    ));
    // Reconciliation may match one exact caption line inside a coarse PDF.js
    // block that also contains a table title, diagram labels, or neighbouring
    // captions. Preserve that line-level evidence across preparation instead
    // of re-expanding it to the aggregate source block and producing a false
    // caption-overlap failure.
    const captionRect = asset.captionRect
      ?? (asset.captionUnitId ? blocks.get(asset.captionUnitId)?.rect : undefined);
    const geometry = validateImmutableRegion(asset, page, intersecting, captionRect);
    const blockingGeometryIssues = portraitPages.has(asset.pageIndex) && isPortraitAsset(doc, asset)
      ? geometry.issues.filter((issue) => issue !== 'body-prose-density')
      : geometry.issues;
    if (blockingGeometryIssues.length) {
      const rect = [asset.rect.x, asset.rect.y, asset.rect.w, asset.rect.h]
        .map((value) => Number(value.toFixed(2))).join(',');
      throw new Error(`不可变资产 ${asset.id} 几何校验失败（第 ${asset.pageIndex + 1} 页：${blockingGeometryIssues.join(', ')}；bbox=${rect}）`);
    }
  }

  const horizontalRows: LayoutRegion[] = [];
  const captionGroups = new Map<string, DetectedAssetRegion[]>();
  for (const asset of assetRegions) {
    if (!asset.captionUnitId || !['figure', 'table', 'code'].includes(asset.kind)) continue;
    const group = captionGroups.get(asset.captionUnitId) ?? [];
    group.push(asset);
    captionGroups.set(asset.captionUnitId, group);
  }
  const groupedAssetIds = new Set<string>();
  for (const [captionId, members] of captionGroups) {
    if (members.length < 2) continue;
    const first = members[0]!;
    if (!members.every((member) => member.kind === first.kind && member.pageIndex === first.pageIndex)) continue;
    const caption = units.find((unit) => unit.id === captionId);
    if (!caption) continue;
    // Keep all panels with their one caption, including vertically stacked
    // panels that the horizontal-band pass would otherwise separate.
    members.sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x);
    const memberIds = members.map((asset) => asset.id);
    const orderedUnitIds = first.kind === 'figure'
      ? [...memberIds, captionId] : [captionId, ...memberIds];
    const groupId = `asset-group-${captionId}`;
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((id) => !orderedUnitIds.includes(id));
    }
    for (const unit of units) {
      if (orderedUnitIds.includes(unit.id)) unit.layoutRegionId = groupId;
    }
    memberIds.forEach((id) => groupedAssetIds.add(id));
    const left = Math.min(...members.map((asset) => asset.rect.x));
    const top = Math.min(...members.map((asset) => asset.rect.y));
    const right = Math.max(...members.map((asset) => asset.rect.x + asset.rect.w));
    const bottom = Math.max(...members.map((asset) => asset.rect.y + asset.rect.h));
    horizontalRows.push({
      id: groupId, mode: right - left > doc.meta.paperWidth * 0.54 ? 'full-width' : 'single',
      sourcePage: first.pageIndex, bounds: { x: left, y: top, w: right - left, h: bottom - top },
      orderedUnitIds,
    });
  }
  const pageKindGroups = new Map<string, DetectedAssetRegion[]>();
  for (const asset of assetRegions) {
    if (groupedAssetIds.has(asset.id)) continue;
    if (asset.kind !== 'figure' && asset.kind !== 'table') continue;
    const key = `${asset.pageIndex}:${asset.kind}`;
    const group = pageKindGroups.get(key) ?? [];
    group.push(asset);
    pageKindGroups.set(key, group);
  }
  for (const [key, candidates] of pageKindGroups) {
    const portraitPage = candidates.length >= 3
      && candidates.every((asset) => isPortraitAsset(doc, asset))
      && isAuthorBiographyPage(doc, candidates[0]!.pageIndex);
    const pending = [...candidates].sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x);
    let rowNumber = 0;
    while (pending.length) {
      const anchor = pending.shift()!;
      const band = [anchor];
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const candidate = pending[index]!;
        const overlap = Math.max(0, Math.min(
          anchor.rect.y + anchor.rect.h,
          candidate.rect.y + candidate.rect.h,
        ) - Math.max(anchor.rect.y, candidate.rect.y));
        if ((portraitPage && isPortraitAsset(doc, anchor) && isPortraitAsset(doc, candidate))
          || (Math.abs(candidate.rect.y - anchor.rect.y) <= 12
            && overlap / Math.max(1, Math.min(anchor.rect.h, candidate.rect.h)) >= 0.6)) {
          band.push(candidate);
          pending.splice(index, 1);
        }
      }
      if (band.length < 2) continue;
      band.sort((left, right) => left.rect.x - right.rect.x || left.rect.y - right.rect.y);
      const grouped = new Map<string, DetectedAssetRegion[]>();
      for (const asset of band) {
        const captionKey = asset.captionUnitId ?? `asset:${asset.id}`;
        const members = grouped.get(captionKey) ?? [];
        members.push(asset);
        grouped.set(captionKey, members);
      }
      const orderedUnitIds: string[] = [];
      for (const members of grouped.values()) {
        const captionId = members[0]?.captionUnitId;
        if (members[0]?.kind === 'table' && captionId) orderedUnitIds.push(captionId);
        orderedUnitIds.push(...members.map((asset) => asset.id));
        if (members[0]?.kind === 'figure' && captionId) orderedUnitIds.push(captionId);
      }
      const uniqueUnitIds = [...new Set(orderedUnitIds)];
      const left = Math.min(...band.map((asset) => asset.rect.x));
      const top = Math.min(...band.map((asset) => asset.rect.y));
      const right = Math.max(...band.map((asset) => asset.rect.x + asset.rect.w));
      const bottom = Math.max(...band.map((asset) => asset.rect.y + asset.rect.h));
      const [pageText, kind] = key.split(':');
      const rowId = `asset-row-p${Number(pageText) + 1}-${kind}-${++rowNumber}`;
      for (const region of regions) {
        region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !uniqueUnitIds.includes(unitId));
      }
      for (const unit of units) {
        if (uniqueUnitIds.includes(unit.id)) unit.layoutRegionId = rowId;
      }
      horizontalRows.push({
        id: rowId,
        mode: 'full-width',
        presentation: 'horizontal',
        sourcePage: anchor.pageIndex,
        bounds: { x: left, y: top, w: right - left, h: bottom - top },
        orderedUnitIds: uniqueUnitIds,
      });
    }
  }
  if (horizontalRows.length) {
    for (const pageIndex of [...new Set(horizontalRows.map((row) => row.sourcePage))]) {
      const rows = horizontalRows
        .filter((row) => row.sourcePage === pageIndex)
        .sort((left, right) => left.bounds.y - right.bounds.y);
      for (const row of rows) {
        const unitOrders = new Map(units.map((unit) => [unit.id, unit.order]));
        const rowOrder = Math.min(...row.orderedUnitIds.map((id) => unitOrders.get(id) ?? Infinity));
        const at = regions.findIndex((region) => region.sourcePage === pageIndex
          && region.orderedUnitIds.some((id) => (unitOrders.get(id) ?? Infinity) >= rowOrder));
        if (at < 0) {
          const nextPage = regions.findIndex((region) => region.sourcePage > pageIndex);
          regions.splice(nextPage < 0 ? regions.length : nextPage, 0, row);
          continue;
        }
        const region = regions[at]!;
        const before = region.orderedUnitIds.filter((id) => (unitOrders.get(id) ?? Infinity) < rowOrder);
        if (!before.length) {
          regions.splice(at, 0, row);
          continue;
        }
        // Inserting the row at page start would put it ahead of the title and
        // preceding prose. Split the containing flow at the source-order anchor.
        const after = region.orderedUnitIds.filter((id) => !before.includes(id));
        const tail = { ...region, id: `${region.id}-after-${row.id}`, orderedUnitIds: after };
        region.orderedUnitIds = before;
        for (const unit of units) {
          if (after.includes(unit.id)) unit.layoutRegionId = tail.id;
        }
        regions.splice(at + 1, 0, row, tail);
      }
    }
    for (let index = regions.length - 1; index >= 0; index -= 1) {
      if (!regions[index]!.orderedUnitIds.length) regions.splice(index, 1);
    }
  }

  // Splitting out an inline formula can expose a sentence continuation that
  // the PDF placed in the next text block. Keep a dangling conjunction with
  // that exact neighbouring prose, preserving both original geometry owners.
  const orderedUnits = [...units].sort((left, right) => left.order - right.order);
  const joinedIds = new Set<string>();
  for (let index = 0; index < orderedUnits.length - 1; index += 1) {
    const left = orderedUnits[index]!;
    const right = orderedUnits[index + 1]!;
    if (left.kind !== 'paragraph' || right.kind !== 'paragraph'
      || !left.id.includes('-inline-') || !left.sourceText || !right.sourceText
      || !/\b(?:and|or)\s*$/u.test(left.sourceText) || !/^[a-z]/u.test(right.sourceText)) continue;
    const leftBlock = blocks.get(left.sourceBlockId ?? left.id);
    const rightBlock = blocks.get(right.sourceBlockId ?? right.id);
    if (!leftBlock || !rightBlock || leftBlock.id === rightBlock.id
      || leftBlock.pageIndex !== rightBlock.pageIndex
      || !sameVisualColumn(leftBlock, rightBlock, doc.meta.paperWidth)) continue;
    const gap = rightBlock.rect.y - leftBlock.rect.y - leftBlock.rect.h;
    if (gap < -2 || gap > 16) continue;
    left.sourceText = `${left.sourceText} ${right.sourceText}`;
    left.sourceBlockIds = [...new Set([
      ...(left.sourceBlockIds ?? [leftBlock.id]), ...(right.sourceBlockIds ?? [rightBlock.id]),
    ])];
    left.protectedTokens = extractProtectedTokens(left.sourceText);
    joinedIds.add(right.id);
    orderedUnits.splice(index + 1, 1);
    index -= 1;
  }
  units = units.filter((unit) => !joinedIds.has(unit.id));
  for (const region of regions) region.orderedUnitIds = region.orderedUnitIds.filter((id) => !joinedIds.has(id));

  // Numeric normalization must happen after every coordinate-based crop.
  // Earlier normalization changes source offsets and would make the original
  // PDF character rectangles unusable for inline formula extraction.
  // Formula-fragment transfers can consume an entire text unit. Keep the
  // semantic list and region references consistent with the request builder,
  // which intentionally never submits empty text for translation.
  const emptyTextIds = new Set(units
    .filter((unit) => !unit.assetId && unit.sourceText !== undefined && !unit.sourceText.trim())
    .map((unit) => unit.id));
  units = units.filter((unit) => !emptyTextIds.has(unit.id));
  for (const region of regions) {
    region.orderedUnitIds = region.orderedUnitIds.filter((id) => !emptyTextIds.has(id));
  }
  for (const unit of units) {
    if (!unit.sourceText || unit.kind === 'reference') continue;
    const normalized = normalizePdfNumericSpacing(unit.sourceText, unit.kind === 'heading');
    if (normalized === unit.sourceText) continue;
    unit.sourceText = normalized;
    unit.protectedTokens = extractProtectedTokens(normalized);
  }

  for (const unit of [...units]) {
    if (!unit.sourceText || !['paragraph', 'abstract', 'list-item'].includes(unit.kind)) continue;
    const parts = splitOversizedSourceText(unit.sourceText);
    if (parts.length < 2) continue;
    const children = parts.map((sourceText, index): SemanticUnit => ({
      ...unit,
      id: `${unit.id}-part-${index + 1}`,
      parentId: unit.id,
      sourceText,
      protectedTokens: extractProtectedTokens(sourceText),
      order: unit.order + (index + 1) / (parts.length + 1) / 1_000,
    }));
    const unitIndex = units.indexOf(unit);
    units.splice(unitIndex, 1, ...children);
    const region = regions.find((candidate) => candidate.id === unit.layoutRegionId);
    const regionIndex = region?.orderedUnitIds.indexOf(unit.id) ?? -1;
    if (region && regionIndex >= 0) {
      region.orderedUnitIds.splice(regionIndex, 1, ...children.map((child) => child.id));
    }
  }

  return {
    regions,
    units: units.sort((left, right) => left.order - right.order),
    assetRegions,
  };
}
