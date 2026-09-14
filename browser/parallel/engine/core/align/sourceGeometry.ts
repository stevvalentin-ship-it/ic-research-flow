import type { ImmutableAsset } from '../assets/types';
import type { CharRect } from '../parser/charRects';
import type {
  AlignmentRectSet,
  AlignmentUnit,
  Block,
  Doc,
  Rect,
} from '../../types/models';

export interface TextRangeRectInput {
  page?: number;
  start: number;
  end: number;
  charRects: CharRect[];
}

function asRect(char: CharRect): Rect {
  return { x: char.x, y: char.y, w: char.w, h: char.h };
}

function mergeLineRects(chars: CharRect[]): Rect[] {
  const lines: Array<{ rect: Rect; widths: number[] }> = [];
  for (const char of chars) {
    const rect = asRect(char);
    const current = lines[lines.length - 1];
    if (!current) {
      lines.push({ rect, widths: [rect.w] });
      continue;
    }
    const currentCenter = current.rect.y + current.rect.h / 2;
    const nextCenter = rect.y + rect.h / 2;
    const verticalTolerance = Math.max(current.rect.h, rect.h) * 0.35;
    const averageWidth = [...current.widths, rect.w]
      .reduce((sum, width) => sum + width, 0) / (current.widths.length + 1);
    const currentRight = current.rect.x + current.rect.w;
    const horizontalGap = rect.x - currentRight;
    const followsLine = rect.x >= current.rect.x - averageWidth
      && horizontalGap <= averageWidth * 2;

    if (Math.abs(currentCenter - nextCenter) <= verticalTolerance && followsLine) {
      const x1 = Math.min(current.rect.x, rect.x);
      const y1 = Math.min(current.rect.y, rect.y);
      const x2 = Math.max(currentRight, rect.x + rect.w);
      const y2 = Math.max(current.rect.y + current.rect.h, rect.y + rect.h);
      current.rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      current.widths.push(rect.w);
    } else {
      lines.push({ rect, widths: [rect.w] });
    }
  }
  return lines.map((line) => line.rect);
}

export function resolveTextRangeRects(input: TextRangeRectInput): AlignmentRectSet[] {
  const byPage = new Map<number, CharRect[]>();
  input.charRects.forEach((char, arrayIndex) => {
    const sourceIndex = char.sourceIndex ?? arrayIndex;
    if (sourceIndex < input.start || sourceIndex >= input.end) return;
    const page = char.pageIndex ?? input.page ?? 0;
    const entries = byPage.get(page) ?? [];
    entries.push(char);
    byPage.set(page, entries);
  });
  return [...byPage.entries()]
    .sort(([left], [right]) => left - right)
    .map(([page, chars]) => ({ page, rects: mergeLineRects(chars) }));
}

function geometryForBlock(block: Block): AlignmentRectSet[] {
  if (block.fragments?.length) {
    return block.fragments.map((fragment) => ({ page: fragment.pageIndex, rects: [{ ...fragment.rect }] }));
  }
  return [{ page: block.pageIndex, rects: [{ ...block.rect }] }];
}

function indexedChars(block: Block): CharRect[] {
  if (block.characterRects?.length) {
    return block.characterRects.map((char) => ({
      ch: char.ch,
      sourceIndex: char.sourceIndex,
      pageIndex: char.pageIndex,
      ...char.rect,
    }));
  }
  return (block.charRects ?? []).map((rect, sourceIndex) => ({
    ch: block.text?.[sourceIndex] ?? '',
    sourceIndex,
    pageIndex: block.pageIndex,
    ...rect,
  }));
}

function normalizeWithSourceIndices(text: string): { normalized: string; sourceIndices: number[] } {
  let normalized = '';
  const sourceIndices: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const expanded = text[index].normalize('NFKC');
    for (const char of expanded) {
      if (/\s/u.test(char)) continue;
      normalized += char;
      sourceIndices.push(index);
    }
  }
  return { normalized, sourceIndices };
}

function findExactTextRange(text: string, needle: string, from: number): [number, number] | null {
  const exactStart = text.indexOf(needle, from);
  if (exactStart >= 0) return [exactStart, exactStart + needle.length];

  const source = normalizeWithSourceIndices(text);
  const target = normalizeWithSourceIndices(needle).normalized;
  return findNormalizedTextRange(source, target, from);
}

function findNormalizedTextRange(
  source: ReturnType<typeof normalizeWithSourceIndices>, target: string, from: number,
): [number, number] | null {
  const normalizedFrom = source.sourceIndices.findIndex((index) => index >= from);
  const matchAt = source.normalized.indexOf(target, Math.max(0, normalizedFrom));
  if (matchAt < 0 || target.length === 0) return null;
  const start = source.sourceIndices[matchAt];
  const finalIndex = source.sourceIndices[matchAt + target.length - 1];
  return [start, finalIndex + 1];
}

function normalizedLength(text: string): number {
  return normalizeWithSourceIndices(text).normalized.length;
}

function findSplitTextRanges(
  designatedBlock: Block,
  candidates: Block[],
  needle: string,
  from: number,
): Array<{ block: Block; range: [number, number] }> | null {
  const normalizedNeedle = normalizeWithSourceIndices(needle).normalized;
  const prefixSource = normalizeWithSourceIndices(designatedBlock.text ?? '');
  // PDF extraction may put the final URL path on its own short line/block.
  // Require an exact adjacent continuation at both block boundaries.
  if (/https?:\/\//u.test(needle)) {
    const source = normalizeWithSourceIndices(designatedBlock.text ?? '').normalized;
    for (const candidate of candidates.filter((entry) => (
      entry.order === designatedBlock.order + 1
      && entry.pageIndex >= designatedBlock.pageIndex
      && entry.pageIndex <= designatedBlock.pageIndex + 1
    ))) {
      const suffix = normalizeWithSourceIndices(candidate.text ?? '').normalized;
      if (suffix.length < 4 || !normalizedNeedle.endsWith(suffix)) continue;
      const prefix = normalizedNeedle.slice(0, -suffix.length);
      if (!/https?:\/\/\S+$/u.test(prefix) || !source.endsWith(prefix)) continue;
      const first = findExactTextRange(designatedBlock.text ?? '', prefix, from);
      const second = findExactTextRange(candidate.text ?? '', suffix, 0);
      if (first && second) return [{ block: designatedBlock, range: first }, { block: candidate, range: second }];
    }
  }
  const minimumPartLength = 16;
  if (normalizedNeedle.length < minimumPartLength * 2) return null;
  for (
    let split = normalizedNeedle.length - minimumPartLength;
    split >= minimumPartLength;
    split -= 1
  ) {
    const prefixRange = findNormalizedTextRange(
      prefixSource,
      normalizedNeedle.slice(0, split),
      from,
    );
    if (!prefixRange) continue;
    const suffix = normalizedNeedle.slice(split);
    const suffixMatch = candidates
      .filter((candidate) => candidate.id !== designatedBlock.id && hasCharacterGeometry(candidate))
      .map((candidate) => ({
        block: candidate,
        range: findExactTextRange(candidate.text ?? '', suffix, 0),
      }))
      .filter((candidate): candidate is { block: Block; range: [number, number] } => Boolean(candidate.range))
      .sort((left, right) => (
        Math.abs(left.block.pageIndex - designatedBlock.pageIndex)
        - Math.abs(right.block.pageIndex - designatedBlock.pageIndex)
      ))[0];
    if (suffixMatch) {
      return [
        { block: designatedBlock, range: prefixRange },
        suffixMatch,
      ];
    }
  }

  // A sentence can be interrupted by a page/column figure after a short but
  // meaningful prefix such as "If we naively", with its long continuation
  // beginning the following PDF block. Keep the normal 16-character floor
  // above, and relax only this exact, adjacent, strongly anchored shape.
  if (normalizedNeedle.length >= 48) {
    for (let split = 15; split >= 4; split -= 1) {
      const prefixRange = findNormalizedTextRange(
        prefixSource,
        normalizedNeedle.slice(0, split),
        from,
      );
      if (!prefixRange) continue;
      const prefixText = (designatedBlock.text ?? '').slice(prefixRange[0], prefixRange[1]);
      const trailingText = (designatedBlock.text ?? '').slice(prefixRange[1]);
      const prefixWords = prefixText.match(/[A-Za-z]{2,}/g) ?? [];
      const trailingFunctionWords = trailingText.match(
        /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|if|we)\b/gi,
      ) ?? [];
      const veryShortPrefix = split < 8;
      if (veryShortPrefix) {
        if (
          !/^(?:This|That|These|Those|It)$/u.test(prefixText.trim())
          || normalizedLength(trailingText) > 0
        ) continue;
      } else if (
        prefixWords.length < 2
        || prefixRange[0] < (designatedBlock.text?.length ?? 0) * 0.65
        || trailingFunctionWords.length > 1
      ) continue;
      const suffix = normalizedNeedle.slice(split);
      const suffixMatch = candidates
        .filter((candidate) => (
          candidate.id !== designatedBlock.id
          && hasCharacterGeometry(candidate)
          && candidate.order > designatedBlock.order
          && candidate.pageIndex >= designatedBlock.pageIndex
          && candidate.pageIndex <= designatedBlock.pageIndex + 1
        ))
        .map((candidate) => ({
          block: candidate,
          range: findExactTextRange(candidate.text ?? '', suffix, 0),
        }))
        .filter((candidate): candidate is { block: Block; range: [number, number] } => (
          Boolean(candidate.range)
          && normalizedLength(candidate.block.text?.slice(0, candidate.range?.[0]) ?? '') <= 4
        ))
        .sort((left, right) => left.block.order - right.block.order)[0];
      if (suffixMatch) {
        return [
          { block: designatedBlock, range: prefixRange },
          suffixMatch,
        ];
      }
    }
  }
  return null;
}

interface WordToken {
  value: string;
  start: number;
  end: number;
}

function wordTokens(text: string): WordToken[] {
  return [...text.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => ({
    // Preparation can reattach a detached PDF subscript (`W asted` followed
    // by separate `res` rows) as `Wasted_res` for translation. Geometry still
    // points at the original glyphs, so compare that repaired token by its
    // base variable name while retaining the full source range.
    value: match[0].normalize('NFKC').toLocaleLowerCase().replace(/_res$/u, ''),
    start: match.index!,
    end: match.index! + match[0].length,
  }));
}

function findOrderedTokenRanges(text: string, needle: string, from: number): {
  ranges: Array<[number, number]>;
  confidence: number;
} | null {
  const target = wordTokens(needle);
  const source = wordTokens(text).filter((token) => token.end > from);
  if (target.length < 4 || source.length < target.length) return null;

  const matchedSourceIndexes: number[] = [];
  let sourceCursor = 0;
  let skippedBoundaryFragments = 0;
  for (const targetToken of target) {
    const remainingSource = source.slice(sourceCursor);
    const relativeIndex = remainingSource
      .findIndex((sourceToken) => {
        if (sourceToken.value === targetToken.value) return true;
        const shorter = sourceToken.value.length < targetToken.value.length
          ? sourceToken.value
          : targetToken.value;
        const longer = shorter === sourceToken.value ? targetToken.value : sourceToken.value;
        // A split PDF block can lose a few leading glyphs at the part boundary
        // (for example `analysis` becoming `lysis`). Accept only a close suffix
        // relation; wider or internal fuzzy matches remain disallowed.
        return shorter.length >= 4
          && longer.length - shorter.length <= 4
          && (longer.endsWith(shorter) || longer.startsWith(shorter));
      });
    if (relativeIndex < 0) {
      // Cropping a bitmap out of a PDF text aggregate can leave only one or
      // two letters at either edge of the removed area (`ba ... om` for a
      // masked word and `d-vanced` for the following one). Those fragments do
      // not describe additional source content. Ignore a small bounded number
      // of alphabetic edge fragments, while still requiring every meaningful
      // token to match in order.
      if (/^\p{L}{1,2}$/u.test(targetToken.value)) {
        skippedBoundaryFragments += 1;
        if (skippedBoundaryFragments <= Math.max(2, Math.floor(target.length * 0.25))) continue;
      }
      return null;
    }
    // A tiny token is useful when it is genuinely next in the source (`Lu`),
    // but must not jump far ahead to an unrelated initial and consume the
    // cursor before the next meaningful word.
    if (/^\p{L}{1,2}$/u.test(targetToken.value) && relativeIndex > 2) {
      skippedBoundaryFragments += 1;
      if (skippedBoundaryFragments <= Math.max(2, Math.floor(target.length * 0.25))) continue;
      return null;
    }
    const sourceIndex = sourceCursor + relativeIndex;
    matchedSourceIndexes.push(sourceIndex);
    sourceCursor = sourceIndex + 1;
  }

  if (matchedSourceIndexes.length < 4) return null;

  const firstIndex = matchedSourceIndexes[0]!;
  const lastIndex = matchedSourceIndexes.at(-1)!;
  const spannedTokenCount = lastIndex - firstIndex + 1;
  const skippedText = matchedSourceIndexes.slice(1).flatMap((sourceIndex, index) => {
    const previousIndex = matchedSourceIndexes[index]!;
    return sourceIndex > previousIndex + 1
      ? [text.slice(source[previousIndex]!.end, source[sourceIndex]!.start)]
      : [];
  }).join('\n');
  // Four- or five-word fragments are sufficiently distinctive only when the
  // omitted source contains no prose words. This covers a sentence split by
  // a frozen numeric formula ("requires 1024 - 15 = 1009 operations") while
  // refusing a short match that jumps over unrelated natural language.
  if (target.length < 6 && wordTokens(skippedText).some((token) => (
    /\p{L}/u.test(token.value) && [...token.value].length > 1
  ))) {
    return null;
  }
  // Exact ordered tokens are a strong signal, but cap the amount of skipped
  // source material so repeated words cannot bridge unrelated paragraphs.
  if (spannedTokenCount > target.length * 3 + 24) {
    const publisherBoilerplate = /Permission to make (?:digital or hard|digital|hard) copies\b/i.test(skippedText)
      && /(?:Copyright held by|ACM ISBN|doi[.]org\/)/i.test(skippedText);
    if (!publisherBoilerplate) return null;
  }

  const ranges: Array<[number, number]> = [];
  let rangeStartIndex = matchedSourceIndexes[0]!;
  let previousIndex = rangeStartIndex;
  for (const sourceIndex of matchedSourceIndexes.slice(1)) {
    if (sourceIndex !== previousIndex + 1) {
      ranges.push([source[rangeStartIndex]!.start, source[previousIndex]!.end]);
      rangeStartIndex = sourceIndex;
    }
    previousIndex = sourceIndex;
  }
  ranges.push([source[rangeStartIndex]!.start, source[previousIndex]!.end]);
  if (ranges.length < 2) return null;
  return { ranges, confidence: 0.92 };
}

function findOrderedFormulaRanges(text: string, needle: string, from: number): {
  ranges: Array<[number, number]>;
  confidence: number;
} | null {
  const source = normalizeWithSourceIndices(text);
  const target = normalizeWithSourceIndices(needle).normalized;
  const normalizedFrom = source.sourceIndices.findIndex((index) => index >= from);
  if (
    target.length < 3
    || target.length > 24
    || !/[=+−∑∏∫≤≥<>]/u.test(target)
    || normalizedFrom < 0
  ) {
    return null;
  }

  const matchedNormalizedIndexes: number[] = [];
  let cursor = normalizedFrom;
  for (const targetChar of target) {
    const relativeIndex = source.normalized.slice(cursor).indexOf(targetChar);
    if (relativeIndex < 0) return null;
    const sourceIndex = cursor + relativeIndex;
    matchedNormalizedIndexes.push(sourceIndex);
    cursor = sourceIndex + 1;
  }

  const firstIndex = matchedNormalizedIndexes[0]!;
  const lastIndex = matchedNormalizedIndexes.at(-1)!;
  if (lastIndex - firstIndex + 1 > target.length * 4 + 12) return null;

  const matched = new Set(matchedNormalizedIndexes);
  const skippedText = source.normalized
    .slice(firstIndex, lastIndex + 1)
    .split('')
    .filter((_, index) => !matched.has(firstIndex + index))
    .join('');
  if (wordTokens(skippedText).some((token) => (
    [...token.value].filter((char) => /\p{L}/u.test(char)).length > 1
  ))) {
    return null;
  }

  const rawIndexes = matchedNormalizedIndexes.map((index) => source.sourceIndices[index]!);
  const ranges: Array<[number, number]> = [];
  let rangeStart = rawIndexes[0]!;
  let previous = rangeStart;
  for (const rawIndex of rawIndexes.slice(1)) {
    if (rawIndex !== previous + 1) {
      ranges.push([rangeStart, previous + 1]);
      rangeStart = rawIndex;
    }
    previous = rawIndex;
  }
  ranges.push([rangeStart, previous + 1]);
  return { ranges, confidence: 0.9 };
}

/**
 * Semi-global token alignment: match the complete sentence against the best
 * substring of one source block while tolerating a small number of inserted
 * diagram labels or missing function words. The threshold is deliberately
 * strict so an unrelated repeated sentence cannot acquire plausible geometry.
 */
function findApproximateTokenRange(text: string, needle: string, from: number): {
  range: [number, number];
  confidence: number;
} | null {
  const target = wordTokens(needle);
  const source = wordTokens(text).filter((token) => token.end > from);
  if (target.length < 4 || source.length < target.length * 0.5) return null;

  let previousCosts = Array.from({ length: source.length + 1 }, () => 0);
  let previousStarts = Array.from({ length: source.length + 1 }, (_, index) => index);
  for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
    const costs = Array.from({ length: source.length + 1 }, () => 0);
    const starts = Array.from({ length: source.length + 1 }, () => 0);
    costs[0] = targetIndex;
    for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
      const substitutionCost = previousCosts[sourceIndex - 1]!
        + (target[targetIndex - 1]!.value === source[sourceIndex - 1]!.value ? 0 : 1);
      const missingSourceCost = previousCosts[sourceIndex]! + 1;
      const insertedSourceCost = costs[sourceIndex - 1]! + 1;
      const best = Math.min(substitutionCost, missingSourceCost, insertedSourceCost);
      costs[sourceIndex] = best;
      starts[sourceIndex] = best === substitutionCost
        ? previousStarts[sourceIndex - 1]!
        : best === missingSourceCost
          ? previousStarts[sourceIndex]!
          : starts[sourceIndex - 1]!;
    }
    previousCosts = costs;
    previousStarts = starts;
  }

  let endIndex = 1;
  for (let index = 2; index <= source.length; index += 1) {
    if (previousCosts[index]! < previousCosts[endIndex]!) endIndex = index;
  }
  const edits = previousCosts[endIndex]!;
  const startIndex = previousStarts[endIndex]!;
  const confidence = 1 - edits / target.length;
  if (startIndex >= endIndex || confidence < 0.82) return null;
  return {
    range: [source[startIndex]!.start, source[endIndex - 1]!.end],
    confidence: Math.min(0.95, confidence),
  };
}

function withSource(
  unit: AlignmentUnit,
  source: AlignmentRectSet[],
  confidence = 1,
  fallbackReason?: string,
): AlignmentUnit {
  if (!source.length) {
    return {
      ...unit, source: [], confidence: 0, status: 'unmatched',
      fallbackReason: fallbackReason ?? 'source-geometry-missing',
    };
  }
  return {
    ...unit,
    source,
    confidence,
    status: confidence >= 0.9 ? 'aligned' : 'low-confidence',
    fallbackReason: fallbackReason ?? unit.fallbackReason,
  };
}

function hasCharacterGeometry(block: Block): boolean {
  return Boolean(block.characterRects?.length || block.charRects?.length);
}

export function resolveSourceGeometry(
  units: AlignmentUnit[],
  doc: Doc,
  assets: ImmutableAsset[],
): AlignmentUnit[] {
  const blocks = new Map(doc.blocks.map((block) => [block.id, block]));
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const cursorByBlock = new Map<string, number>();

  return units.map((unit) => {
    if (unit.kind === 'asset') {
      const asset = assetsById.get(unit.id)
        ?? assets.find((candidate) => unit.sourceUnitIds.includes(candidate.id));
      return asset
        ? withSource(unit, [{ page: asset.sourcePage, rects: [{ ...asset.sourceRect }] }])
        : withSource(unit, []);
    }

    const explicitBlocks = (unit.sourceBlockIds ?? [])
      .map((id) => blocks.get(id))
      .filter((candidate): candidate is Block => Boolean(candidate));
    let block = blocks.get(unit.sourceBlockId ?? '')
      ?? explicitBlocks[0]
      ?? blocks.get(unit.parentId ?? '')
      ?? unit.sourceUnitIds.map((id) => blocks.get(id)).find(Boolean)
      ?? blocks.get(unit.id);
    if (!block) return withSource(unit, []);

    const requiresTextRange = unit.kind === 'semantic-group'
      || unit.relation === 'paragraph-fallback';
    if (!requiresTextRange || !unit.sourceText) {
      return withSource(unit, geometryForBlock(block));
    }

    const designatedBlock = block;
    let range = findExactTextRange(
      block.text ?? '',
      unit.sourceText,
      cursorByBlock.get(block.id) ?? 0,
    );
    let sourceConfidence = 1;
    let fallbackReason: string | undefined;

    // A preserved inline variable can separate a lone prose word from its
    // punctuation ("vector k." becomes "vector" + asset + "."). Match the
    // unique whole word in its designated block, without claiming the asset.
    if (!range) {
      const word = unit.sourceText.match(/^\s*(\p{L}{4,})\s*[.,;:!?]\s*$/u)?.[1];
      if (word) {
        const from = cursorByBlock.get(block.id) ?? 0;
        const matches = [...(block.text ?? '').matchAll(/\p{L}+/gu)]
          .filter((match) => match[0] === word && match.index! >= from);
        if (matches.length === 1) {
          range = [matches[0]!.index!, matches[0]!.index! + word.length];
          sourceConfidence = 0.95;
          fallbackReason = 'source-word-separated-from-punctuation';
        }
      }
    }

    // PDF.js can splice a visually ordinary sentence into a separate margin
    // metadata block. Preparation restores its reading order, but its glyph
    // coordinates remain in that original block. Search for an exact copy
    // across blocks before attempting any fuzzy match.
    if (!range && normalizedLength(unit.sourceText) >= 20) {
      const relocated = doc.blocks
        .filter((candidate) => candidate.id !== designatedBlock.id && hasCharacterGeometry(candidate))
        .map((candidate) => ({
          block: candidate,
          range: findExactTextRange(candidate.text ?? '', unit.sourceText!, cursorByBlock.get(candidate.id) ?? 0),
        }))
        .filter((candidate): candidate is { block: Block; range: [number, number] } => Boolean(candidate.range))
        .sort((left, right) => (
          Math.abs(left.block.pageIndex - designatedBlock.pageIndex)
          - Math.abs(right.block.pageIndex - designatedBlock.pageIndex)
        ))[0];
      if (relocated) {
        block = relocated.block;
        range = relocated.range;
        sourceConfidence = 0.95;
        fallbackReason = 'source-sentence-relocated-to-origin-block';
      }
    }

    if (!range) {
      const splitLocations = findSplitTextRanges(
        designatedBlock,
        doc.blocks,
        unit.sourceText,
        cursorByBlock.get(designatedBlock.id) ?? 0,
      );
      if (splitLocations) {
        const source = splitLocations.flatMap((location) => {
          const chars = indexedChars(location.block);
          cursorByBlock.set(location.block.id, location.range[1]);
          return resolveTextRangeRects({
            start: location.range[0],
            end: location.range[1],
            page: location.block.pageIndex,
            charRects: chars,
          });
        });
        if (source.length) {
          return withSource(unit, source, 0.95, 'source-sentence-split-across-origin-blocks');
        }
      }
    }

    if (!range) {
      const approximate = findApproximateTokenRange(
        designatedBlock.text ?? '',
        unit.sourceText,
        cursorByBlock.get(designatedBlock.id) ?? 0,
      );
      if (approximate) {
        block = designatedBlock;
        range = approximate.range;
        sourceConfidence = approximate.confidence;
        fallbackReason = 'source-sentence-fuzzy-token-match';
      }
    }

    if (!range) {
      const orderedRanges = findOrderedTokenRanges(
        designatedBlock.text ?? '',
        unit.sourceText,
        cursorByBlock.get(designatedBlock.id) ?? 0,
      );
      if (orderedRanges) {
        const chars = indexedChars(designatedBlock);
        const source = orderedRanges.ranges.flatMap(([start, end]) => resolveTextRangeRects({
          start,
          end,
          page: designatedBlock.pageIndex,
          charRects: chars,
        }));
        if (source.length) {
          cursorByBlock.set(designatedBlock.id, orderedRanges.ranges.at(-1)![1]);
          return withSource(
            unit,
            source,
            orderedRanges.confidence,
            'source-sentence-matched-across-masked-ranges',
          );
        }
      }
    }

    if (!range) {
      const formulaRanges = findOrderedFormulaRanges(
        designatedBlock.text ?? '',
        unit.sourceText,
        cursorByBlock.get(designatedBlock.id) ?? 0,
      );
      if (formulaRanges) {
        const chars = indexedChars(designatedBlock);
        const source = formulaRanges.ranges.flatMap(([start, end]) => resolveTextRangeRects({
          start,
          end,
          page: designatedBlock.pageIndex,
          charRects: chars,
        }));
        if (source.length) {
          cursorByBlock.set(designatedBlock.id, formulaRanges.ranges.at(-1)![1]);
          return withSource(
            unit,
            source,
            formulaRanges.confidence,
            'source-formula-matched-across-stacked-ranges',
          );
        }
      }
    }

    if (!range && explicitBlocks.length > 1 && unit.sourceText) {
      const requestedTokens = new Set(
        unit.sourceText.toLocaleLowerCase().match(/[a-z0-9]{2,}/g) ?? [],
      );
      const supportingBlocks = explicitBlocks.filter((candidate) => (
        (candidate.text ?? '').toLocaleLowerCase().match(/[a-z0-9]{2,}/g) ?? []
      ).some((token) => requestedTokens.has(token)));
      if (supportingBlocks.length > 1) {
        return withSource(
          unit,
          supportingBlocks.flatMap((candidate) => geometryForBlock(candidate)),
          0.75,
          'source-reconstructed-across-explicit-blocks',
        );
      }
    }

    const chars = indexedChars(block);
    if (!range || chars.length === 0) {
      // A text-range unit must never highlight an entire multi-paragraph PDF
      // aggregate. This includes paragraph fallbacks created from one split
      // translation unit: their sourceBlockId still points at the unsplit PDF
      // block, whose rectangle can cover most of a column. Only use that block
      // rectangle when the requested text itself covers nearly the whole block;
      // otherwise fail closed and let the quality gate report the unresolved
      // source geometry.
      const coverage = normalizedLength(unit.sourceText)
        / Math.max(1, normalizedLength(block.text ?? ''));
      return coverage >= 0.8
        ? withSource(unit, geometryForBlock(block), 0.75, 'source-sentence-fell-back-to-block')
        : withSource(unit, [], 0, 'source-sentence-range-unresolved');
    }
    cursorByBlock.set(block.id, range[1]);
    const sentenceGeometry = resolveTextRangeRects({
      start: range[0],
      end: range[1],
      page: block.pageIndex,
      charRects: chars,
    });
    return sentenceGeometry.length
      ? withSource(unit, sentenceGeometry, sourceConfidence, fallbackReason)
      : withSource(unit, geometryForBlock(block), 0.75, 'source-sentence-fell-back-to-block');
  });
}
