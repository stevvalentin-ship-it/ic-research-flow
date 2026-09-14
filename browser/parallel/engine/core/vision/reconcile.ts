import type { Doc, Rect } from '../../types/models';
import type { DetectedAssetRegion } from '../assets/extract';
import { validateImmutableRegion, type ImmutableGeometryIssue } from '../assets/geometryGate';
import { isAlgorithmCaptionText, isFigureCaptionText, isTableCaptionText } from '../parser/blocks';
import type { VisionPageAnalysis, VisionRegion, NormalizedVisionBox } from './protocol';

export type VisionReconciliationReason =
  | 'low-confidence'
  | 'caption-unmatched'
  | 'implausible-formula-cluster'
  | ImmutableGeometryIssue;

export interface UnresolvedVisionRegion {
  pageIndex: number;
  regionIndex: number;
  regionId?: string;
  type: VisionRegion['type'];
  reason: VisionReconciliationReason;
}

export interface VisionReconciliationResult {
  assetRegions: DetectedAssetRegion[];
  unresolved: UnresolvedVisionRegion[];
}

function sourceRect(box: NormalizedVisionBox, page: { width: number; height: number }): Rect {
  const [x, y, width, height] = box;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    x: round(x / 1000 * page.width),
    y: round(y / 1000 * page.height),
    w: round(width / 1000 * page.width),
    h: round(height / 1000 * page.height),
  };
}

function intersectionArea(left: Rect, right: Rect): number {
  return Math.max(0, Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x))
    * Math.max(0, Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y));
}

function withExactRasterFigureBounds(
  rect: Rect,
  type: VisionRegion['type'],
  pageIndex: number,
  bitmapRegionsByPage: ReadonlyMap<number, readonly Rect[]>,
): Rect {
  if (type !== 'figure') return rect;
  const rectArea = Math.max(1, rect.w * rect.h);
  const candidates = (bitmapRegionsByPage.get(pageIndex) ?? []).flatMap((candidate) => {
    const candidateArea = Math.max(1, candidate.w * candidate.h);
    const overlap = intersectionArea(rect, candidate);
    const overlapOfSmaller = overlap / Math.min(rectArea, candidateArea);
    const areaRatio = candidateArea / rectArea;
    const widthRatio = candidate.w / Math.max(1, rect.w);
    // A PDF bitmap XObject can contain several adjacent plots. It is exact for
    // the underlying object but not for the individual figure described by the
    // Vision region. Do not let such a materially wider object absorb its
    // neighbour; a tight Vision box is safer in that case.
    // The reverse mismatch is equally unsafe: charts are often assembled from
    // several bitmap/vector objects, so snapping a complete Vision box to one
    // much narrower XObject silently drops neighbouring bars or panels.
    if (overlapOfSmaller < 0.55 || areaRatio < 0.25 || areaRatio > 3.5
      || widthRatio < 0.7 || widthRatio > 1.5) return [];
    const unionArea = rectArea + candidateArea - overlap;
    return [{ candidate, score: overlap / Math.max(1, unionArea) }];
  }).sort((left, right) => right.score - left.score);
  const exact = candidates[0]?.candidate;
  return exact ? { ...exact } : rect;
}

function captionIdentity(text: string | undefined): string | undefined {
  const match = (text ?? '').match(
    /(?:^|\n)\s*(fig(?:ure)?|table|algorithm)\s*[.]?\s*(\d+(?:[.-]\d+)*|[IVXLCDM]+)\b/i,
  );
  if (!match) return undefined;
  const kind = /^fig/i.test(match[1]!) ? 'figure' : match[1]!.toLocaleLowerCase();
  return `${kind}:${match[2]!.toLocaleLowerCase()}`;
}

function captionFor(
  doc: Doc,
  pageIndex: number,
  captionRect: Rect | undefined,
  assetType: VisionRegion['type'],
  assetRect: Rect,
  visibleLabel?: string,
): Doc['blocks'][number] | undefined {
  const candidates: Doc['blocks'][number][] = doc.blocks.flatMap<Doc['blocks'][number]>((block) => {
    if (block.pageIndex !== pageIndex) return [];
    const text = block.text ?? '';
    const matches = assetType === 'table'
      ? isTableCaptionText(text)
      : assetType === 'figure'
        ? isFigureCaptionText(text)
        : assetType === 'code'
          ? isAlgorithmCaptionText(text)
        : block.type === 'caption';
    if (!matches) return [];
    if ((assetType !== 'figure' && assetType !== 'table') || !block.characterRects?.length) {
      return [block];
    }
    const matchedCaptionLines: Doc['blocks'] = [];
    let offset = 0;
    for (const line of text.split(/\r?\n/)) {
      const start = offset;
      const end = start + line.length;
      offset = end + 1;
      const lineMatches = assetType === 'figure'
        ? isFigureCaptionText(line)
        : isTableCaptionText(line);
      if (!lineMatches) continue;
      const characters = block.characterRects.filter((character) => (
        character.sourceIndex >= start
        && character.sourceIndex < end
        && character.ch.trim().length > 0
      ));
      if (!characters.length) return [block];
      const left = Math.min(...characters.map((character) => character.rect.x));
      const top = Math.min(...characters.map((character) => character.rect.y));
      const right = Math.max(...characters.map((character) => character.rect.x + character.rect.w));
      const bottom = Math.max(...characters.map((character) => character.rect.y + character.rect.h));
      matchedCaptionLines.push({
        ...block,
        type: 'caption' as const,
        text: line,
        rect: { x: left, y: top, w: right - left, h: bottom - top },
      });
    }
    return matchedCaptionLines.length ? matchedCaptionLines : [block];
  });
  const expectedIdentity = captionIdentity(visibleLabel);
  if (expectedIdentity) {
    const exact = candidates.filter((block) => captionIdentity(block.text) === expectedIdentity);
    // A unique number printed in both the rendered page and the PDF text
    // layer is stronger identity evidence than a coarse caption rectangle.
    // Prefer it before nearest-neighbour geometry so a displaced model box
    // cannot silently link Fig. N to the adjacent Fig. N+1 caption.
    if (exact.length === 1) return exact[0];
  }
  if (captionRect) {
    const overlapping = candidates
      .map((block) => ({ block, overlap: intersectionArea(block.rect, captionRect) }))
      .filter((candidate) => candidate.overlap / Math.max(1, candidate.block.rect.w * candidate.block.rect.h) >= 0.2)
      .sort((left, right) => right.overlap - left.overlap)[0]?.block;
    if (overlapping) return overlapping;

    const captionCenterX = captionRect.x + captionRect.w / 2;
    const captionCenterY = captionRect.y + captionRect.h / 2;
    const nearby = candidates
      .map((block) => {
        const horizontalOverlap = Math.max(0, Math.min(
          block.rect.x + block.rect.w,
          captionRect.x + captionRect.w,
        ) - Math.max(block.rect.x, captionRect.x));
        const horizontalRatio = horizontalOverlap / Math.max(1, Math.min(block.rect.w, captionRect.w));
        const dx = Math.abs(block.rect.x + block.rect.w / 2 - captionCenterX);
        const dy = Math.abs(block.rect.y + block.rect.h / 2 - captionCenterY);
        return { block, horizontalRatio, distance: Math.hypot(dx, dy), dy };
      })
      .filter((candidate) => (
        candidate.horizontalRatio >= 0.25
        && candidate.dy <= Math.max(144, captionRect.h * 4, candidate.block.rect.h * 4)
      ))
      .sort((left, right) => left.distance - right.distance)[0]?.block;
    if (nearby) return nearby;
  }

  if (assetType !== 'figure' && assetType !== 'table' && assetType !== 'code') return undefined;
  return candidates
    .map((block) => {
      const horizontalOverlap = Math.max(0, Math.min(
        block.rect.x + block.rect.w,
        assetRect.x + assetRect.w,
      ) - Math.max(block.rect.x, assetRect.x));
      const horizontalRatio = horizontalOverlap / Math.max(1, Math.min(block.rect.w, assetRect.w));
      const gap = assetType === 'figure'
        ? block.rect.y - (assetRect.y + assetRect.h)
        : assetRect.y - (block.rect.y + block.rect.h);
      return { block, horizontalRatio, gap };
    })
    .filter((candidate) => candidate.horizontalRatio >= 0.2 && candidate.gap >= -20 && candidate.gap <= 80)
    .sort((left, right) => Math.abs(left.gap) - Math.abs(right.gap))[0]?.block;
}

function withoutCaption(
  rect: Rect,
  captionRects: readonly (Rect | undefined)[],
  type: VisionRegion['type'],
  confirmedPosition?: VisionRegion['captionPosition'],
): Rect {
  const applicable = captionRects.filter((candidate): candidate is Rect => Boolean(
    candidate && intersectionArea(rect, candidate) > 0,
  ));
  if (!applicable.length) return rect;
  const bottom = rect.y + rect.h;
  const assetCenter = rect.y + rect.h / 2;
  // Once a caption has been linked to a unique printed identity, its declared
  // side is a hard crop boundary. Label-recovery may have enlarged the asset
  // far enough that the old centre heuristic now sees a below-caption above
  // the enlarged centre and accidentally keeps it inside the immutable crop.
  if (type === 'figure' && confirmedPosition === 'below') {
    const confirmedBelow = applicable.filter((candidate) => candidate.y > rect.y + 8);
    if (confirmedBelow.length) {
      const trimmedBottom = Math.min(...confirmedBelow.map((candidate) => candidate.y)) - 2;
      if (trimmedBottom > rect.y + 12) return { ...rect, h: trimmedBottom - rect.y };
    }
  }
  if ((type === 'table' || type === 'code') && confirmedPosition === 'above') {
    const confirmedAbove = applicable.filter((candidate) => candidate.y + candidate.h < bottom - 8);
    if (confirmedAbove.length) {
      const trimmedTop = Math.max(...confirmedAbove.map((candidate) => candidate.y + candidate.h)) + 2;
      if (trimmedTop < bottom - 12) return { ...rect, y: trimmedTop, h: bottom - trimmedTop };
    }
  }
  const below = applicable.filter((candidate) => candidate.y + candidate.h / 2 >= assetCenter);
  if (type === 'figure' && below.length) {
    const trimmedBottom = Math.max(rect.y, Math.min(...below.map((candidate) => candidate.y)) - 2);
    return { ...rect, h: trimmedBottom - rect.y };
  }
  const above = applicable.filter((candidate) => candidate.y + candidate.h / 2 <= assetCenter);
  if ((type === 'table' || type === 'code') && above.length) {
    const trimmedTop = Math.min(bottom, Math.max(...above.map((candidate) => candidate.y + candidate.h)) + 2);
    return { ...rect, y: trimmedTop, h: bottom - trimmedTop };
  }
  return rect;
}

function withAdjacentCaptionClearance(rect: Rect, caption: Rect | undefined, type: VisionRegion['type']): Rect {
  if (!caption) return rect;
  const bottom = rect.y + rect.h;
  if (type === 'table') {
    const captionBottom = caption.y + caption.h;
    const top = captionBottom + 4;
    if (rect.y >= captionBottom - 1 && rect.y < top && top < bottom - 12) {
      return { ...rect, y: top, h: bottom - top };
    }
  }
  if (type === 'figure') {
    const trimmedBottom = caption.y - 4;
    if (bottom <= caption.y + 1 && bottom > trimmedBottom && trimmedBottom > rect.y + 12) {
      return { ...rect, h: trimmedBottom - rect.y };
    }
  }
  return rect;
}

function tableContentCorroboratesRegion(
  doc: Doc,
  pageIndex: number,
  rect: Rect,
  confidence: number,
): boolean {
  if (confidence < 0.45) return false;
  const page = doc.pages[pageIndex];
  if (!page || rect.w < page.width * 0.5 || rect.h < page.height * 0.045) return false;
  const intersecting = doc.blocks.filter((block) => (
    block.pageIndex === pageIndex
    && intersectionArea(block.rect, rect) / Math.max(1, block.rect.w * block.rect.h) >= 0.12
  ));
  const text = intersecting.map((block) => block.text ?? '').join('\n');
  const numbers = text.match(/(?<![A-Za-z])[-+]?\d+(?:[.,]\d+)?(?:%|x)?/g) ?? [];
  const rowSignals = text.match(/(?:^|\s)(?:CPU|GPU|ASIC|FPGA|MHz|GHz|mW|[A-Z][A-Za-z-]+)\s+[-+]?\d/g) ?? [];
  return numbers.length >= 18
    && (intersecting.length >= 2 || numbers.length >= 30)
    && (rowSignals.length >= 2 || numbers.length >= 40);
}

function captionGeometryCorroboratesRegion(
  caption: Doc['blocks'][number] | undefined,
  captionRect: Rect | undefined,
): boolean {
  if (!caption || !captionRect) return false;
  const overlap = intersectionArea(caption.rect, captionRect);
  if (overlap / Math.max(1, caption.rect.w * caption.rect.h) >= 0.2) return true;

  // Multimodal layout responses are often coarse by one rendered text line.
  // A nearby box still independently identifies the PDF caption when it shares
  // most of the same horizontal lane; accepting that evidence is safer than
  // falling back to a guessed caption-gap crop that may preserve only half of
  // a vector figure.
  const horizontalOverlap = Math.max(0, Math.min(
    caption.rect.x + caption.rect.w,
    captionRect.x + captionRect.w,
  ) - Math.max(caption.rect.x, captionRect.x));
  const horizontalRatio = horizontalOverlap / Math.max(1, Math.min(caption.rect.w, captionRect.w));
  const centerDistanceY = Math.abs(
    caption.rect.y + caption.rect.h / 2 - (captionRect.y + captionRect.h / 2),
  );
  return horizontalRatio >= 0.6
    && centerDistanceY <= Math.max(36, caption.rect.h * 2.5, captionRect.h * 2.5);
}

function formulaGeometryCorroboratesRegion(
  doc: Doc,
  pageIndex: number,
  rect: Rect,
  confidence: number,
): boolean {
  if (confidence < 0.45 || implausibleFormulaInk(doc, pageIndex, rect)) return false;
  return doc.blocks.some((block) => {
    if (block.pageIndex !== pageIndex || block.type !== 'equation') return false;
    const overlap = intersectionArea(block.rect, rect);
    return overlap / Math.max(1, block.rect.w * block.rect.h) >= 0.5;
  });
}

function isAuthorBiographyPage(doc: Doc, pageIndex: number): boolean {
  const text = doc.blocks
    .filter((block) => block.pageIndex === pageIndex)
    .map((block) => block.text ?? '')
    .join('\n');
  const degreeSignals = text.match(/\breceived\b[\s\S]{0,160}?\bdegree\b/gi) ?? [];
  return degreeSignals.length >= 3;
}

function isPortraitRect(page: { width: number; height: number }, rect: Rect): boolean {
  const widthRatio = rect.w / page.width;
  const heightRatio = rect.h / page.height;
  const aspect = rect.w / Math.max(1, rect.h);
  return widthRatio >= 0.08 && widthRatio <= 0.22
    && heightRatio >= 0.08 && heightRatio <= 0.22
    && aspect >= 0.55 && aspect <= 1.5;
}

/**
 * Author headshots in publisher PDFs are usually raster XObjects. Prefer their
 * exact paint rectangles over approximate multimodal boxes: the latter can
 * include a biography line or miss the top of a face by tens of points.
 */
export function authorPortraitAssetsFromBitmapRegions(
  doc: Doc,
  bitmapRegions: ReadonlyMap<number, readonly Rect[]>,
): DetectedAssetRegion[] {
  const assets: DetectedAssetRegion[] = [];
  for (const [pageIndex, regions] of bitmapRegions) {
    const page = doc.pages[pageIndex];
    if (!page || !isAuthorBiographyPage(doc, pageIndex)) continue;
    const portraits = regions
      .filter((rect) => isPortraitRect(page, rect))
      .sort((left, right) => left.x - right.x || left.y - right.y);
    if (portraits.length < 3) continue;
    portraits.forEach((rect, index) => assets.push({
      id: `bitmap-p${pageIndex + 1}-portrait-${index + 1}`,
      kind: 'figure', pageIndex, rect: { ...rect }, widthMode: 'column',
    }));
  }
  return assets;
}

function portraitClusterIndices(
  doc: Doc,
  pageIndex: number,
  analysis: VisionPageAnalysis,
): Set<number> {
  if (!isAuthorBiographyPage(doc, pageIndex)) return new Set();
  const candidates = analysis.regions
    .map((region, index) => ({ region, index }))
    .filter(({ region }) => {
      if (region.type !== 'figure' || region.captionBBox || region.confidence < 0.45) return false;
      const [, , width, height] = region.bbox;
      const aspect = width / Math.max(1, height);
      return width >= 80 && width <= 180
        && height >= 80 && height <= 180
        && aspect >= 0.6 && aspect <= 1.5;
    });
  return candidates.length >= 3
    ? new Set(candidates.map(({ index }) => index))
    : new Set();
}

function withoutFollowingTableCaption(
  doc: Doc,
  pageIndex: number,
  rect: Rect,
  ownCaptionId: string | undefined,
  type: VisionRegion['type'],
): Rect {
  if (type !== 'table') return rect;
  const bottom = rect.y + rect.h;
  const nextCaption = doc.blocks
    .filter((block) => {
      if (block.id === ownCaptionId || block.pageIndex !== pageIndex || block.type !== 'caption') return false;
      const horizontalOverlap = Math.max(0, Math.min(
        block.rect.x + block.rect.w,
        rect.x + rect.w,
      ) - Math.max(block.rect.x, rect.x));
      return horizontalOverlap > 0
        && block.rect.y > rect.y + 12
        && block.rect.y < bottom;
    })
    .sort((left, right) => left.rect.y - right.rect.y)[0];
  if (!nextCaption) return rect;
  const trimmedBottom = nextCaption.rect.y - 3;
  return trimmedBottom > rect.y + 12 ? { ...rect, h: trimmedBottom - rect.y } : rect;
}

interface CharacterLine {
  y: number;
  bottom: number;
  text: string;
}

function characterLines(doc: Doc, pageIndex: number, rect: Rect): CharacterLine[] {
  const characters = doc.blocks
    .flatMap((block) => block.characterRects ?? [])
    .filter((character) => (
      character.pageIndex === pageIndex
      && intersectionArea(character.rect, rect) > 0
    ))
    .sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x);
  const lines: Array<{ characters: typeof characters }> = [];
  for (const character of characters) {
    const line = lines.find((candidate) => (
      Math.abs(candidate.characters[0]!.rect.y - character.rect.y) <= 2
    ));
    if (line) line.characters.push(character);
    else lines.push({ characters: [character] });
  }
  return lines.map((line) => {
    line.characters.sort((left, right) => left.rect.x - right.rect.x);
    return {
      y: Math.min(...line.characters.map((character) => character.rect.y)),
      bottom: Math.max(...line.characters.map((character) => character.rect.y + character.rect.h)),
      text: line.characters.map((character) => character.ch).join(''),
    };
  }).sort((left, right) => left.y - right.y);
}

function withoutTopMarginFurniture(doc: Doc, pageIndex: number, rect: Rect, type: VisionRegion['type']): Rect {
  if ((type !== 'figure' && type !== 'table') || rect.y > doc.pages[pageIndex]!.height * 0.12) return rect;
  const page = doc.pages[pageIndex]!;
  const furniture = characterLines(doc, pageIndex, rect).filter((line) => {
    const naturalWords = line.text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
    return line.y < page.height * 0.1
      && line.y < rect.y + 40
      && naturalWords >= 4
      && line.text.trim().length >= 24;
  });
  if (!furniture.length) return rect;
  const bottom = rect.y + rect.h;
  const top = Math.max(...furniture.map((line) => line.bottom)) + 4;
  return top < bottom - 12 ? { ...rect, y: top, h: bottom - top } : rect;
}

function withoutTrailingProse(doc: Doc, pageIndex: number, rect: Rect, type: VisionRegion['type']): Rect {
  if (type !== 'table' && type !== 'code') return rect;
  const lines = characterLines(doc, pageIndex, rect);
  if (lines.length < 4) return rect;
  for (let index = 3; index < lines.length; index += 1) {
    const previous = lines[index - 1]!;
    const current = lines[index]!;
    const whitespace = current.y - previous.bottom;
    const proseWords = current.text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
    const proseLike = type === 'table'
      ? proseWords >= 7 || (proseWords >= 3 && /[.!?]\s*$/.test(current.text))
      : proseWords >= 4 || (proseWords >= 3 && /[.!?]\s*$/.test(current.text));
    if (whitespace < 4 || !proseLike) continue;
    const bottom = Math.min(rect.y + rect.h, previous.bottom + 2);
    if (bottom > rect.y + 12) return { ...rect, h: bottom - rect.y };
  }
  return rect;
}

function withPrecedingTextClearance(
  doc: Doc,
  pageIndex: number,
  rect: Rect,
  type: VisionRegion['type'],
): Rect {
  if (type !== 'figure') return rect;
  const bottom = rect.y + rect.h;
  const touching = doc.blocks
    .filter((block) => {
      if (block.pageIndex !== pageIndex || block.type === 'caption' || looksLikeVisualText(block)) return false;
      const blockBottom = block.rect.y + block.rect.h;
      const horizontalOverlap = Math.max(0, Math.min(
        block.rect.x + block.rect.w,
        rect.x + rect.w,
      ) - Math.max(block.rect.x, rect.x));
      return horizontalOverlap > 0 && blockBottom >= rect.y - 4 && blockBottom <= rect.y + 2;
    })
    .sort((left, right) => right.rect.y + right.rect.h - (left.rect.y + left.rect.h))[0];
  if (!touching) return rect;
  const top = touching.rect.y + touching.rect.h + 6;
  return top < bottom - 12 ? { ...rect, y: top, h: bottom - top } : rect;
}

function withAdjacentVisualLabelExtent(
  doc: Doc,
  pageIndex: number,
  rect: Rect,
  type: VisionRegion['type'],
): Rect {
  if (type !== 'figure') return rect;
  const page = doc.pages[pageIndex]!;
  // A high-confidence wide Vision box already spans the complete visual. PDF
  // text labels inside it must not enlarge the crop: aggregate diagram blocks
  // can otherwise pull the rectangle across most of the page and cause the
  // correct Vision region to be rejected as excessive.
  if (rect.w >= page.width * 0.62) return rect;
  const candidates = doc.blocks.filter((block) => {
    if (block.pageIndex !== pageIndex || block.type === 'caption' || !looksLikeVisualText(block)) return false;
    const verticalOverlap = Math.max(0, Math.min(
      block.rect.y + block.rect.h,
      rect.y + rect.h,
    ) - Math.max(block.rect.y, rect.y));
    const verticalRatio = verticalOverlap / Math.max(1, Math.min(block.rect.h, rect.h));
    const horizontalGap = Math.max(
      0,
      block.rect.x - (rect.x + rect.w),
      rect.x - (block.rect.x + block.rect.w),
    );
    return verticalRatio >= 0.3 && horizontalGap <= page.width * 0.08;
  });
  if (!candidates.length) return rect;
  const left = Math.max(0, Math.min(rect.x, ...candidates.map((block) => block.rect.x)) - 2);
  const top = Math.max(0, Math.min(rect.y, ...candidates.map((block) => block.rect.y)) - 2);
  const right = Math.min(page.width, Math.max(
    rect.x + rect.w,
    ...candidates.map((block) => block.rect.x + block.rect.w),
  ) + 2);
  const bottom = Math.min(page.height, Math.max(
    rect.y + rect.h,
    ...candidates.map((block) => block.rect.y + block.rect.h),
  ) + 2);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function withoutLeadingTableCaptionContinuation(
  doc: Doc,
  pageIndex: number,
  rect: Rect,
  type: VisionRegion['type'],
): Rect {
  if (type !== 'table') return rect;
  const lines = characterLines(doc, pageIndex, rect);
  if (!lines.length) return rect;
  let top = rect.y;
  let consumed = 0;
  for (const line of lines.slice(0, 3)) {
    if (line.y - top > 18) break;
    const text = line.text.replace(/\s+/g, ' ').trim();
    const words = text.match(/[A-Za-z]{2,}/g) ?? [];
    const numbers = text.match(/\d+(?:[.]\d+)?/g) ?? [];
    const captionLike = words.length >= 4
      && numbers.length <= 2
      && (/^[\p{Ll}(]/u.test(text) || /[.!?]\s*$/u.test(text));
    if (!captionLike) break;
    top = line.bottom + 3;
    consumed += 1;
  }
  const bottom = rect.y + rect.h;
  return consumed > 0 && top < bottom - 12 ? { ...rect, y: top, h: bottom - top } : rect;
}

function trimOverlappingSiblingAssets(regions: DetectedAssetRegion[]): DetectedAssetRegion[] {
  for (const code of regions.filter((region) => region.kind === 'code')) {
    for (const visual of regions.filter((region) => (
      region.pageIndex === code.pageIndex && (region.kind === 'figure' || region.kind === 'table')
    ))) {
      const overlap = intersectionArea(code.rect, visual.rect);
      const smaller = Math.max(1, Math.min(
        code.rect.w * code.rect.h,
        visual.rect.w * visual.rect.h,
      ));
      const horizontal = Math.max(0, Math.min(
        code.rect.x + code.rect.w,
        visual.rect.x + visual.rect.w,
      ) - Math.max(code.rect.x, visual.rect.x));
      if (overlap / smaller < 0.2
        || horizontal / Math.max(1, Math.min(code.rect.w, visual.rect.w)) < 0.45) continue;
      if (code.rect.y < visual.rect.y && visual.rect.y > code.rect.y + 12) {
        code.rect = { ...code.rect, h: Math.max(12, visual.rect.y - code.rect.y - 3) };
      } else if (visual.rect.y < code.rect.y && visual.rect.y + visual.rect.h < code.rect.y + code.rect.h - 12) {
        const bottom = code.rect.y + code.rect.h;
        const top = visual.rect.y + visual.rect.h + 3;
        code.rect = { ...code.rect, y: top, h: Math.max(12, bottom - top) };
      }
    }
  }
  return regions;
}

function looksLikeVisualText(block: Doc['blocks'][number]): boolean {
  const text = block.text?.trim() ?? '';
  if (!text) return true;
  const shortLines = text.split(/\r?\n/).filter(Boolean).filter((line) => line.trim().length <= 32).length;
  return shortLines >= 4 || block.type === 'figure' || block.type === 'table' || block.type === 'equation';
}

function regionArea(region: DetectedAssetRegion): number {
  return region.rect.w * region.rect.h;
}

function preferredRegion(left: DetectedAssetRegion, right: DetectedAssetRegion): DetectedAssetRegion {
  if (Boolean(left.captionUnitId) !== Boolean(right.captionUnitId)) return left.captionUnitId ? left : right;
  return regionArea(left) >= regionArea(right) ? left : right;
}

function deduplicateRegions(regions: readonly DetectedAssetRegion[]): DetectedAssetRegion[] {
  const kept: DetectedAssetRegion[] = [];
  for (const region of regions) {
    const duplicateIndex = kept.findIndex((candidate) => {
      if (candidate.pageIndex !== region.pageIndex || candidate.kind !== region.kind) return false;
      const overlap = intersectionArea(candidate.rect, region.rect);
      const containment = overlap / Math.max(1, Math.min(regionArea(candidate), regionArea(region)));
      const centerDx = Math.abs(
        candidate.rect.x + candidate.rect.w / 2 - (region.rect.x + region.rect.w / 2),
      );
      const centerDy = Math.abs(
        candidate.rect.y + candidate.rect.h / 2 - (region.rect.y + region.rect.h / 2),
      );
      const sameVisualAnchor = centerDx <= Math.min(candidate.rect.w, region.rect.w) * 0.2
        && centerDy <= Math.min(candidate.rect.h, region.rect.h) * 0.25;
      return containment >= 0.8 || (
        Boolean(candidate.captionUnitId)
        && candidate.captionUnitId === region.captionUnitId
        // PDF.js can merge several side-by-side captions into one physical
        // block. Those independent assets temporarily share a caption ID and
        // may have coarse boxes that overlap, but their centres remain far
        // apart. Only use caption identity as duplicate evidence when both
        // detections point at the same visual anchor.
        && sameVisualAnchor
        && overlap / Math.max(1, Math.max(regionArea(candidate), regionArea(region))) >= 0.45
      );
    });
    if (duplicateIndex < 0) kept.push(region);
    else kept[duplicateIndex] = preferredRegion(kept[duplicateIndex]!, region);
  }
  return kept;
}

function withoutNestedFormulaRegions(regions: readonly DetectedAssetRegion[]): DetectedAssetRegion[] {
  return regions.filter((region) => {
    if (region.kind !== 'formula') return true;
    const formulaArea = Math.max(1, regionArea(region));
    return !regions.some((container) => (
      container !== region
      && container.pageIndex === region.pageIndex
      && (container.kind === 'figure' || container.kind === 'table' || container.kind === 'code')
      && intersectionArea(region.rect, container.rect) / formulaArea >= 0.75
    ));
  });
}

const ASSET_KIND = {
  figure: 'figure', table: 'table', display_formula: 'formula', code: 'code',
} as const;

function implausibleFormulaClusterIndices(doc: Doc, analysis: VisionPageAnalysis): Set<number> {
  const obviousThinPageRows = analysis.regions
    .map((region, index) => ({ region, index }))
    .filter(({ region }) => (
      region.type === 'display_formula'
      && region.bbox[2] >= 650
      && region.bbox[3] <= 24
    ));
  const candidates = analysis.regions
    .map((region, index) => ({ region, index }))
    .filter(({ region }) => (
      region.type === 'display_formula'
      && region.bbox[2] >= 320
      && region.bbox[3] <= 40
    ))
    .sort((left, right) => left.region.bbox[1] - right.region.bbox[1]);
  const rejected = new Set<number>(obviousThinPageRows.map(({ index }) => index));
  let cluster: typeof candidates = [];
  const flush = () => {
    if (cluster.length >= 6) cluster.forEach(({ index }) => rejected.add(index));
    cluster = [];
  };
  for (const candidate of candidates) {
    const previous = cluster.at(-1);
    if (!previous) {
      cluster.push(candidate);
      continue;
    }
    const [x, y, width, height] = candidate.region.bbox;
    const [previousX, previousY, previousWidth, previousHeight] = previous.region.bbox;
    const sameThinRowShape = Math.abs(x - previousX) <= 20
      && Math.abs(width - previousWidth) <= 30
      && Math.abs(height - previousHeight) <= 10;
    const verticalStep = y - previousY;
    if (sameThinRowShape && verticalStep > 0 && verticalStep <= Math.max(34, height * 2.2)) {
      cluster.push(candidate);
    } else {
      flush();
      cluster.push(candidate);
    }
  }
  flush();
  // Shape proposes suspicious rows, but only source text can disprove a
  // formula. Long equations and raster formulas can have the same geometry.
  return new Set([...rejected].filter((index) => implausibleFormulaInk(
    doc, analysis.pageIndex, sourceRect(analysis.regions[index]!.bbox, doc.pages[analysis.pageIndex]!),
  )));
}

function withAssetPadding(
  rect: Rect,
  type: VisionRegion['type'],
  page: { width: number; height: number },
): Rect {
  if (type !== 'table' && type !== 'display_formula') return rect;
  const horizontal = type === 'table' ? 4 : 5;
  const topPadding = type === 'table' ? 12 : 4;
  const bottomPadding = type === 'table'
    ? 6
    : Math.min(16, Math.max(6, rect.h * 0.18));
  const left = Math.max(0, rect.x - horizontal);
  const top = Math.max(0, rect.y - topPadding);
  const right = Math.min(page.width, rect.x + rect.w + horizontal);
  const bottom = Math.min(page.height, rect.y + rect.h + bottomPadding);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function withSingleColumnFormulaWidth(
  doc: Doc,
  pageIndex: number,
  rect: Rect,
  analysis: VisionPageAnalysis,
  vision: VisionRegion,
): Rect {
  if (vision.type !== 'display_formula' || vision.column !== 'full' || analysis.layout !== 'single') {
    return rect;
  }
  const centerY = rect.y + rect.h / 2;
  const region = doc.layoutRegions
    .filter((candidate) => (
      candidate.sourcePage === pageIndex
      && candidate.mode === 'full-width'
      && centerY >= candidate.bounds.y - 24
      && centerY <= candidate.bounds.y + candidate.bounds.h + 24
    ))
    .sort((left, right) => left.bounds.w - right.bounds.w)[0];
  if (!region) return rect;
  const left = Math.min(rect.x, region.bounds.x);
  const right = Math.max(rect.x + rect.w, region.bounds.x + region.bounds.w);
  return { ...rect, x: left, w: right - left };
}

function formulaProseLike(block: Doc['blocks'][number]): boolean {
  if (block.type !== 'paragraph') return false;
  const text = block.text?.replace(/\s+/g, ' ').trim() ?? '';
  const words = text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  return text.length >= 45 && words >= 6;
}

function implausibleFormulaInk(doc: Doc, pageIndex: number, rect: Rect): boolean {
  if (doc.blocks.some((block) => block.pageIndex === pageIndex && block.type === 'equation'
    && intersectionArea(block.rect, rect) / Math.max(1, block.rect.w * block.rect.h) >= 0.5)) return false;
  const characters = doc.blocks
    .flatMap((block) => (block.characterRects ?? []).map((character) => ({
      ...character, blockOrder: block.order,
    })))
    .filter((character) => {
      if (character.pageIndex !== pageIndex) return false;
      const centerX = character.rect.x + character.rect.w / 2;
      const centerY = character.rect.y + character.rect.h / 2;
      return centerX >= rect.x && centerX <= rect.x + rect.w
        && centerY >= rect.y && centerY <= rect.y + rect.h;
    })
    .sort((left, right) => left.blockOrder - right.blockOrder || left.sourceIndex - right.sourceIndex);
  const text = characters.map((character) => character.ch).join('').replace(/\s+/g, ' ').trim();
  const naturalWords = text.match(/[A-Za-z]{3,}/g) ?? [];
  const functionWords = text.match(
    /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|shown)\b/gi,
  ) ?? [];
  const hasMath = /[=+*/∑∏∫√≤≥≈≠<>×÷\d]|(?:^|\s)-(?:\s|$)/u.test(text);
  // No text-layer ink is inconclusive: formulas may be raster images or
  // outlined vector glyphs. Absence of text is never proof of body prose.
  return !hasMath && (
    (naturalWords.length >= 3 && functionWords.length >= 1)
    // A small misplaced crop may contain only part of a prose line, such as
    // "ired by the Pi". Two grammatical words still disprove a math-only crop.
    || (naturalWords.length >= 2 && functionWords.length >= 2)
  );
}

function withoutAdjacentFormulaProse(
  doc: Doc,
  pageIndex: number,
  padded: Rect,
  unpadded: Rect,
  type: VisionRegion['type'],
): Rect {
  if (type !== 'display_formula') return padded;
  let top = padded.y;
  let bottom = padded.y + padded.h;
  const horizontalOverlap = (rect: Rect) => Math.max(0, Math.min(
    rect.x + rect.w,
    padded.x + padded.w,
  ) - Math.max(rect.x, padded.x));
  const prose = doc.blocks.filter((block) => (
    block.pageIndex === pageIndex
    && formulaProseLike(block)
    && horizontalOverlap(block.rect) > 0
  ));
  const previousBottom = Math.max(-Infinity, ...prose
    .map((block) => block.rect.y + block.rect.h)
    .filter((candidate) => candidate <= unpadded.y + 1));
  if (Number.isFinite(previousBottom)) top = Math.max(top, previousBottom + 2);
  const nextTop = Math.min(Infinity, ...prose
    .map((block) => block.rect.y)
    .filter((candidate) => candidate >= unpadded.y + unpadded.h - 1));
  if (Number.isFinite(nextTop)) bottom = Math.min(bottom, nextTop - 2);
  return bottom > top + 8 ? { ...padded, y: top, h: bottom - top } : padded;
}

export function reconcileVisionLayout(
  doc: Doc,
  analyses: readonly VisionPageAnalysis[],
  minimumConfidence = 0.8,
  bitmapRegionsByPage: ReadonlyMap<number, readonly Rect[]> = new Map(),
): VisionReconciliationResult {
  const byPage = new Map<number, VisionPageAnalysis>();
  for (const analysis of analyses) {
    if (byPage.has(analysis.pageIndex)) throw new Error(`Vision 版式分析包含重复的第 ${analysis.pageIndex + 1} 页`);
    byPage.set(analysis.pageIndex, analysis);
  }
  for (const page of doc.pages) {
    if (!byPage.has(page.pageIndex)) throw new Error(`Vision 版式分析缺少第 ${page.pageIndex + 1} 页`);
  }

  const assetRegions: DetectedAssetRegion[] = [];
  const unresolved: UnresolvedVisionRegion[] = [];
  for (const page of doc.pages) {
    const analysis = byPage.get(page.pageIndex)!;
    const implausibleFormulaIndices = implausibleFormulaClusterIndices(doc, analysis);
    const portraitIndices = portraitClusterIndices(doc, page.pageIndex, analysis);
    const exactBitmapPortraitsAvailable = (bitmapRegionsByPage.get(page.pageIndex) ?? [])
      .filter((rect) => isPortraitRect(page, rect)).length >= 3;
    analysis.regions.forEach((vision, regionIndex) => {
      if (!(vision.type in ASSET_KIND)) return;
      if (exactBitmapPortraitsAvailable && portraitIndices.has(regionIndex)) {
        // On an author-biography page the PDF raster XObjects provide exact
        // headshot boundaries. Approximate Vision portrait boxes can be shifted
        // into the wrapped biography prose even when they look like a coherent
        // portrait cluster. Reject the whole approximate cluster locally; the
        // caller replaces it with the deterministic bitmap rectangles after
        // the accepted page plan has removed these proposals.
        unresolved.push({
          pageIndex: page.pageIndex,
          regionIndex,
          regionId: vision.localId,
          type: vision.type,
          reason: 'body-prose-density',
        });
        return;
      }
      if (implausibleFormulaIndices.has(regionIndex)) {
        unresolved.push({
          pageIndex: page.pageIndex,
          regionIndex,
          regionId: vision.localId,
          type: vision.type,
          reason: 'implausible-formula-cluster',
        });
        return;
      }
      const sourceVisionRect = sourceRect(vision.bbox, page);
      let rect = withAssetPadding(sourceVisionRect, vision.type, page);
      rect = withSingleColumnFormulaWidth(doc, page.pageIndex, rect, analysis, vision);
      rect = withoutAdjacentFormulaProse(doc, page.pageIndex, rect, sourceVisionRect, vision.type);
      const captionRect = vision.captionBBox ? sourceRect(vision.captionBBox, page) : undefined;
      const caption = captionFor(
        doc, page.pageIndex, captionRect, vision.type, rect, vision.visibleLabel,
      );
      const tableGeometryCorroborated = vision.type === 'table'
        && tableContentCorroboratesRegion(doc, page.pageIndex, rect, vision.confidence);
      if (captionRect && !caption && !tableGeometryCorroborated) {
        // A hallucinated figure over ordinary body prose can also carry a
        // hallucinated caption box. Treat exact PDF text geometry as stronger
        // evidence than the missing caption so the existing local recovery can
        // remove the false-positive region without spending correction calls on
        // an impossible "find a caption that is not on the page" request.
        const candidate: DetectedAssetRegion = {
          id: vision.localId ?? `vision-p${page.pageIndex + 1}-${vision.type}-${regionIndex + 1}`,
          kind: ASSET_KIND[vision.type as keyof typeof ASSET_KIND],
          pageIndex: page.pageIndex,
          rect,
          widthMode: rect.w >= page.width * 0.55 ? 'span' : 'column',
        };
        const intersecting = doc.blocks.filter((block) => (
          block.pageIndex === page.pageIndex && intersectionArea(block.rect, rect) > 0
        ));
        const locallyProvenProseFalsePositive = vision.type === 'figure'
          && validateImmutableRegion(candidate, page, intersecting).issues.includes('body-prose-density');
        unresolved.push({
          pageIndex: page.pageIndex,
          regionIndex,
          regionId: vision.localId,
          type: vision.type,
          reason: locallyProvenProseFalsePositive ? 'body-prose-density' : 'caption-unmatched',
        });
        return;
      }
      const captionCorroboratesRegion = Boolean(
        vision.confidence >= 0.45
        && (vision.type === 'figure' || vision.type === 'table')
        && captionGeometryCorroboratesRegion(caption, captionRect),
      );
      const formulaGeometryCorroborated = vision.type === 'display_formula'
        && formulaGeometryCorroboratesRegion(doc, page.pageIndex, rect, vision.confidence);
      if (vision.confidence < minimumConfidence
        && !portraitIndices.has(regionIndex)
        && !captionCorroboratesRegion
        && !tableGeometryCorroborated
        && !formulaGeometryCorroborated) {
        unresolved.push({ pageIndex: page.pageIndex, regionIndex, regionId: vision.localId, type: vision.type, reason: 'low-confidence' });
        return;
      }
      if (vision.type === 'display_formula' && implausibleFormulaInk(doc, page.pageIndex, rect)) {
        unresolved.push({ pageIndex: page.pageIndex, regionIndex, regionId: vision.localId, type: vision.type, reason: 'body-prose-density' });
        return;
      }
      rect = withExactRasterFigureBounds(
        rect, vision.type, page.pageIndex, bitmapRegionsByPage,
      );
      rect = withAdjacentVisualLabelExtent(doc, page.pageIndex, rect, vision.type);
      rect = withoutCaption(rect, [caption?.rect], vision.type, vision.captionPosition);
      if (vision.type !== 'table' || !caption) {
        rect = withoutCaption(rect, [captionRect], vision.type);
      }
      rect = withAdjacentCaptionClearance(rect, caption?.rect, vision.type);
      if (!tableGeometryCorroborated || caption) {
        rect = withoutLeadingTableCaptionContinuation(doc, page.pageIndex, rect, vision.type);
      }
      rect = withoutFollowingTableCaption(doc, page.pageIndex, rect, caption?.id, vision.type);
      if (!tableGeometryCorroborated || caption) {
        rect = withoutTopMarginFurniture(doc, page.pageIndex, rect, vision.type);
      }
      rect = withoutTrailingProse(doc, page.pageIndex, rect, vision.type);
      rect = withPrecedingTextClearance(doc, page.pageIndex, rect, vision.type);
      if (vision.type === 'figure' || vision.type === 'table') {
        const findForeignCaption = () => doc.blocks.find((block) => (
          block.pageIndex === page.pageIndex
          && block.id !== caption?.id
          && (vision.type === 'figure' ? isFigureCaptionText(block.text ?? '') : isTableCaptionText(block.text ?? ''))
          && intersectionArea(rect, block.rect) / Math.max(1, block.rect.w * block.rect.h) >= 0.2
        ));
        let foreignCaption = findForeignCaption();
        if (foreignCaption && intersectionArea(sourceVisionRect, foreignCaption.rect) === 0) {
          const sourceBottom = sourceVisionRect.y + sourceVisionRect.h;
          const foreignBottom = foreignCaption.rect.y + foreignCaption.rect.h;
          const rectBottom = rect.y + rect.h;
          if (foreignBottom <= sourceVisionRect.y + 2) {
            const top = foreignBottom + 2;
            if (top < rectBottom - 12) rect = { ...rect, y: top, h: rectBottom - top };
          } else if (foreignCaption.rect.y >= sourceBottom - 2) {
            const bottom = foreignCaption.rect.y - 2;
            if (bottom > rect.y + 12) rect = { ...rect, h: bottom - rect.y };
          }
          foreignCaption = findForeignCaption();
        }
        if (foreignCaption) {
          // The Vision box is attached to the wrong numbered caption. Reject
          // it so the deterministic caption-gap recovery can rebuild both
          // neighbouring figures independently instead of duplicating one.
          unresolved.push({ pageIndex: page.pageIndex, regionIndex, regionId: vision.localId, type: vision.type, reason: 'foreign-caption-overlap' });
          return;
        }
      }
      const asset: DetectedAssetRegion = {
        id: vision.localId
          ?? `vision-p${page.pageIndex + 1}-${vision.type.replace('display_', '')}-${regionIndex + 1}`,
        kind: ASSET_KIND[vision.type as keyof typeof ASSET_KIND],
        pageIndex: page.pageIndex,
        rect,
        // Some multimodal responses call a centered panel "full" even when
        // it occupies only one source column. Physical width is the reliable
        // signal for whether it must span the target columns.
        widthMode: rect.w >= page.width * 0.55 ? 'span' : 'column',
        captionUnitId: caption?.id,
        ...(caption ? { captionRect: { ...caption.rect } } : {}),
      };
      const intersecting = doc.blocks.filter((block) => (
        block.pageIndex === page.pageIndex && intersectionArea(block.rect, rect) > 0
      ));
      const geometry = validateImmutableRegion(asset, page, intersecting, caption?.rect);
      const blockingGeometryIssues = portraitIndices.has(regionIndex)
        ? geometry.issues.filter((issue) => issue !== 'body-prose-density')
        : geometry.issues;
      if (blockingGeometryIssues.length) {
        unresolved.push({
          pageIndex: page.pageIndex, regionIndex, regionId: vision.localId,
          type: vision.type, reason: blockingGeometryIssues[0]!,
        });
        return;
      }
      assetRegions.push(asset);
    });
  }
  return {
    assetRegions: withoutNestedFormulaRegions(trimOverlappingSiblingAssets(deduplicateRegions(assetRegions))),
    unresolved,
  };
}
