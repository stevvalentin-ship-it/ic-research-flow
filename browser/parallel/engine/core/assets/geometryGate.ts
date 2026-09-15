import type { Block, Rect } from '../../types/models';
import type { DetectedAssetRegion } from './extract';

export type ImmutableGeometryIssue =
  | 'page-edge-touch'
  | 'page-coverage-excessive'
  | 'foreign-caption-overlap'
  | 'caption-overlap'
  | 'body-prose-density';

export interface ImmutableGeometryResult {
  pass: boolean;
  issues: ImmutableGeometryIssue[];
}

function intersectionArea(left: Rect, right: Rect): number {
  const width = Math.max(0, Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y));
  return width * height;
}

function looksLikeVisualLabels(text: string | undefined): boolean {
  const lines = (text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const labelLike = lines.filter((line) => (
    line.length <= 32 || /^[-+]?\d[\d.,%‰+\- ]*$/.test(line)
  )).length;
  return labelLike / lines.length >= 0.6;
}

function proseCharacterCount(
  block: Block,
  rect: Rect,
  eraseRects: readonly Rect[] = [],
  preserveRects: readonly Rect[] = [],
  sourceCharacterRanges: readonly { blockId: string; start: number; end: number }[] = [],
): number | undefined {
  // A reconstructed formula composites only the explicitly preserved source
  // glyph boxes. A coarse aggregate paragraph box without character geometry
  // can geometrically contain those glyphs even though none of its prose ink
  // is copied. Treat the compositing mask as the stronger evidence here; an
  // ordinary rectangular crop has no preserveRects and keeps the conservative
  // area-based rejection below.
  if (!block.characterRects?.length) return preserveRects.length ? 0 : undefined;
  const exactRanges = sourceCharacterRanges.filter((range) => range.blockId === block.id);
  const intersecting = block.characterRects.filter((character) => (
    /[A-Za-z\u3400-\u9fff]/.test(character.ch)
    && (exactRanges.length
      ? exactRanges.some((range) => (
        character.sourceIndex >= range.start && character.sourceIndex < range.end
      ))
      : intersectionArea(rect, character.rect) > 0
        && (!preserveRects.length || preserveRects.some((preserve) => {
      const centerX = character.rect.x + character.rect.w / 2;
      const centerY = character.rect.y + character.rect.h / 2;
      return centerX >= preserve.x && centerX <= preserve.x + preserve.w
        && centerY >= preserve.y && centerY <= preserve.y + preserve.h;
        })))
    && !eraseRects.some((erase) => {
      const centerX = character.rect.x + character.rect.w / 2;
      const centerY = character.rect.y + character.rect.h / 2;
      return centerX >= erase.x && centerX <= erase.x + erase.w
        && centerY >= erase.y && centerY <= erase.y + erase.h;
    })
  ));
  if (!intersecting.length) return 0;
  const indexes = [...new Set(intersecting.map((character) => character.sourceIndex))]
    .sort((left, right) => left - right);
  const runs: Array<{ start: number; end: number }> = [];
  for (const index of indexes) {
    const last = runs.at(-1);
    if (last && index <= last.end + 1) last.end = index;
    else runs.push({ start: index, end: index });
  }
  const snippet = preserveRects.length
    ? runs.map((run) => (block.text ?? '').slice(run.start, run.end + 1)).join('\n')
    : (block.text ?? '').slice(indexes[0], indexes.at(-1)! + 1);
  // PDF.js may merge the prose above a diagram with labels inside the diagram.
  // Judge only the characters that actually intersect the crop so a label-only
  // tail does not inherit the prose classification of the aggregate block.
  if (looksLikeVisualLabels(snippet)) return 0;
  const chineseCount = snippet.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const englishWords = snippet.match(/[A-Za-z]{2,}/g) ?? [];
  const functionWords = snippet.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/g) ?? [];
  const sentenceLike = chineseCount >= 12 || (englishWords.length >= 6 && functionWords.length >= 2);
  return sentenceLike ? intersecting.length : 0;
}

export function validateImmutableRegion(
  region: DetectedAssetRegion,
  page: { width: number; height: number },
  intersectingBlocks: readonly Block[],
  captionRect?: Rect,
): ImmutableGeometryResult {
  const issues: ImmutableGeometryIssue[] = [];
  const { rect } = region;
  if (![rect.x, rect.y, rect.w, rect.h, page.width, page.height].every(Number.isFinite)
    || page.width <= 0 || page.height <= 0) {
    return { pass: false, issues: ['page-coverage-excessive'] };
  }
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  if (rect.x < 0 || rect.y <= 0 || right > page.width || bottom > page.height) {
    issues.push('page-edge-touch');
  }

  const pageArea = page.width * page.height;
  const large = rect.w * rect.h / pageArea > 0.5 || rect.h / page.height > 0.78;
  // A nearby, separate caption is positive evidence for a large visual object.
  // Page fraction alone cannot distinguish a full-page table from a bad crop.
  const captionGap = captionRect ? Math.max(
    captionRect.y - bottom, rect.y - captionRect.y - captionRect.h, 0,
  ) : Infinity;
  const anchored = region.kind !== 'formula' && Boolean(region.captionUnitId && captionRect
    && [captionRect.x, captionRect.y, captionRect.w, captionRect.h].every(Number.isFinite)
    && captionRect.w > 0 && captionRect.h > 0
    && captionRect.x >= 0 && captionRect.y >= 0
    && captionRect.x + captionRect.w <= page.width
    && captionRect.y + captionRect.h <= page.height
    && intersectionArea(rect, captionRect) === 0 && captionGap <= 48
    && Math.min(right, captionRect.x + captionRect.w) > Math.max(rect.x, captionRect.x));
  if (rect.w <= 0 || rect.h <= 0
    || (large && !anchored)
    || rect.w * rect.h / pageArea > 0.9 || rect.h / page.height > 0.94) {
    issues.push('page-coverage-excessive');
  }

  if (large && intersectingBlocks.some((block) => (
    block.type === 'caption' && block.id !== region.captionUnitId
    && intersectionArea(rect, block.rect) > 0
  ))) issues.push('foreign-caption-overlap');

  if (captionRect && intersectionArea(rect, captionRect) > 0) issues.push('caption-overlap');

  // Tables and algorithm/code environments legitimately contain dense natural-language
  // labels and comments. Their page-bounds and coverage checks still protect against an
  // accidentally oversized crop; prose-density is only meaningful for figures/formulas.
  if (region.kind !== 'table' && region.kind !== 'code') {
    const longProse = intersectingBlocks.map((block) => ({
      block,
      characterCount: proseCharacterCount(
        block,
        rect,
        region.eraseRects,
        region.preserveRects,
        region.sourceCharacterRanges,
      ),
    })).filter(({ block, characterCount }) => (
      block.type === 'paragraph'
      && (block.text?.replace(/\s+/g, ' ').trim().length ?? 0) >= 45
      && !looksLikeVisualLabels(block.text)
      && ((block.text?.match(/[A-Za-z]{3,}/g)?.length ?? 0) >= 8
        || (block.text?.match(/[\u3400-\u9fff]/g)?.length ?? 0) >= 24)
      && (characterCount === undefined
        ? intersectionArea(rect, block.rect) > 0
        : characterCount > 0)
    ));
    const proseArea = longProse.reduce((total, { block, characterCount }) => (
      total + (characterCount === undefined ? intersectionArea(rect, block.rect) : 0)
    ), 0);
    const characterIntrusion = longProse.reduce((total, candidate) => (
      total + (candidate.characterCount ?? 0)
    ), 0);
    const proseRatio = proseArea / Math.max(1, rect.w * rect.h);
    if (characterIntrusion >= 24
      || (longProse.length >= 3 && proseRatio >= 0.25)
      || proseRatio >= 0.16) {
      issues.push('body-prose-density');
    }
  }

  return { pass: issues.length === 0, issues };
}
