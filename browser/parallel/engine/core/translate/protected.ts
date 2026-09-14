import type {
  TranslationBlockRequest,
  TranslationBlockResponse,
  TranslationResponse,
  TranslationValidationIssue,
  TranslationValidationResult,
} from './protocol';

const PROTECTED_TOKEN_PATTERN = /⟦[^⟧]+⟧|\[\s*(?:\d+(?:\s*[-,]\s*\d+)*)\s*\]|(?<![A-Za-z0-9])[-+]?(?:\d+\.\d+|\d+)(?:%|‰)?/g;
const CITATION_TOKEN_PATTERN = /^\[\s*(?:\d+(?:\s*[-,]\s*\d+)*)\s*\]$/;
const NUMERIC_TOKEN_PATTERN = /^[-+]?(?:\d+\.\d+|\d+)(?:%|‰)?$/;
const FLATTENED_UNIT_EXPONENT_PATTERN = /(?:^|[\s(])(?:pm|nm|μm|µm|mm|cm|dm|m|dam|hm|km|in|ft|yd|mi)\s+([23])(?=$|[\s,.;:)])/gu;
const SUPERSCRIPT_EXPONENT: Record<string, string> = { '2': '²', '3': '³' };

export function extractProtectedTokens(text: string): string[] {
  return Array.from(text.matchAll(PROTECTED_TOKEN_PATTERN), (match) => match[0]);
}

export interface ProtectedTranslationMask {
  blocks: TranslationBlockRequest[];
  replacements: Map<string, string>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function maskProtectedTokensForTranslation(
  blocks: readonly TranslationBlockRequest[],
): ProtectedTranslationMask {
  const replacements = new Map<string, string>();
  const maskedBlocks = blocks.map((block, blockIndex) => {
    const tokens = uniqueInOrder([...block.protectedTokens, ...extractProtectedTokens(block.source)])
      .sort((left, right) => right.length - left.length);
    const tokenPattern = tokens.length
      ? new RegExp(tokens.map(escapeRegExp).join('|'), 'g')
      : undefined;
    const markersByToken = new Map<string, string[]>();
    const sourceMarkers: string[] = [];
    let markerIndex = 0;
    const maskedSource = tokenPattern
      ? block.source.replace(tokenPattern, (token) => {
        const marker = `⟦PP${blockIndex}_${markerIndex}⟧`;
        markerIndex += 1;
        const queue = markersByToken.get(token) ?? [];
        queue.push(marker);
        markersByToken.set(token, queue);
        sourceMarkers.push(marker);
        replacements.set(marker, token);
        return marker;
      })
      : block.source;
    const sentenceOffsets = new Map<string, number>();
    const maskSentence = (value: string): string => tokenPattern
      ? value.replace(tokenPattern, (token) => {
        const offset = sentenceOffsets.get(token) ?? 0;
        const marker = markersByToken.get(token)?.[offset];
        sentenceOffsets.set(token, offset + 1);
        // Sentence candidates are derived from source text and should consume
        // the same markers in order. Keep an explicit token only as a guarded
        // fallback for malformed third-party candidates.
        return marker ?? token;
      })
      : value;
    return {
      ...block,
      source: maskedSource,
      sourceSentences: block.sourceSentences.map((sentence) => ({
        ...sentence,
        text: maskSentence(sentence.text),
      })),
      // Give every occurrence its own marker. Reusing one marker for repeated
      // values encouraged models to deduplicate it and made otherwise correct
      // long translations fail protected-token validation.
      protectedTokens: sourceMarkers,
    };
  });
  return { blocks: maskedBlocks, replacements };
}

export function restoreProtectedTokensFromTranslation(
  response: TranslationResponse,
  replacements: ReadonlyMap<string, string>,
  maskedSourceBlocks: readonly TranslationBlockRequest[] = [],
): TranslationResponse {
  const sources = new Map(maskedSourceBlocks.map((block) => [block.blockId, block]));
  const completed: TranslationResponse = {
    blocks: response.blocks.map((block) => {
      const source = sources.get(block.blockId);
      if (!source?.protectedTokens.length) return block;
      const alignmentGroups = block.alignmentGroups.map((group) => ({
        ...group,
        sourceSentenceIds: [...group.sourceSentenceIds],
        targetSegments: [...group.targetSegments],
      }));
      let changed = false;
      const claimedLiteralTokens = new Map<string, number>();
      for (const marker of uniqueInOrder(source.protectedTokens)) {
        if (alignmentGroups.some((group) => group.targetSegments.some((segment) => segment.includes(marker)))) {
          continue;
        }
        const literal = replacements.get(marker);
        if (literal) {
          const literalCount = alignmentGroups.reduce((count, group) => (
            count + group.targetSegments.reduce((segmentCount, segment) => (
              segmentCount + occurrenceCount(segment, literal)
            ), 0)
          ), 0);
          const claimed = claimedLiteralTokens.get(literal) ?? 0;
          // Some providers return the protected value itself instead of the
          // opaque marker.  Claim that literal occurrence for this marker;
          // inserting another marker would restore the same number/citation a
          // second time and visibly corrupt the translated paragraph.
          if (claimed < literalCount) {
            claimedLiteralTokens.set(literal, claimed + 1);
            continue;
          }
        }
        const sentence = source.sourceSentences.find((candidate) => candidate.text.includes(marker));
        const group = sentence
          ? alignmentGroups.find((candidate) => candidate.sourceSentenceIds.includes(sentence.id))
          : alignmentGroups.at(-1);
        if (!group?.targetSegments.length) continue;
        const sourceOrdinal = sentence ? group.sourceSentenceIds.indexOf(sentence.id) : -1;
        const segmentIndex = sourceOrdinal >= 0 && group.targetSegments.length === group.sourceSentenceIds.length
          ? sourceOrdinal
          : group.targetSegments.length - 1;
        const segment = group.targetSegments[segmentIndex]!;
        const punctuation = segment.match(/([\s]*[。！？.!?]["'”’）)]*)$/u);
        const insertion = punctuation ? segment.length - punctuation[1]!.length : segment.length;
        group.targetSegments[segmentIndex] = `${segment.slice(0, insertion).trimEnd()} ${marker}${segment.slice(insertion)}`;
        changed = true;
      }
      return changed ? {
        ...block,
        alignmentGroups,
        translation: alignmentGroups.flatMap((group) => group.targetSegments).join(''),
      } : block;
    }),
  };
  const restore = (value: string): string => {
    let result = value;
    for (const [marker, token] of replacements) result = result.split(marker).join(token);
    return result;
  };
  return {
    blocks: completed.blocks.map((block) => ({
      ...block,
      translation: restore(block.translation),
      alignmentGroups: block.alignmentGroups.map((group) => ({
        ...group,
        targetSegments: group.targetSegments.map(restore),
      })),
      newTerms: block.newTerms.map((term) => ({
        ...term,
        source: restore(term.source),
        target: restore(term.target),
        ...(term.abbreviation ? { abbreviation: restore(term.abbreviation) } : {}),
      })),
      warnings: block.warnings.map(restore),
    })),
  };
}

function requiredProtectedOccurrenceCount(source: TranslationBlockRequest, token: string): number {
  return Math.max(
    protectedOccurrenceCount(source.source, token),
    source.protectedTokens.filter((value) => (
      CITATION_TOKEN_PATTERN.test(token)
        ? value.replace(/\s+/g, '') === token.replace(/\s+/g, '')
        : value === token
    )).length,
  );
}

function insertProtectedToken(segment: string, token: string): string {
  const punctuation = segment.match(/([\s]*[。！？.!?]["'”’）)]*)$/u);
  const insertion = punctuation ? segment.length - punctuation[1]!.length : segment.length;
  return `${segment.slice(0, insertion).trimEnd()} ${token}${segment.slice(insertion)}`;
}

function restoreLeadingHeadingNumber(
  source: TranslationBlockRequest,
  block: TranslationBlockResponse,
): TranslationBlockResponse {
  if (source.kind !== 'heading') return block;
  const sectionNumber = source.source.match(/^\s*(\d+(?:\.\d+)*)\b/)?.[1];
  if (!sectionNumber) return block;
  const segments = block.alignmentGroups.flatMap((group) => group.targetSegments);
  if (segments.length !== 1) return block;
  const segment = segments[0]!.trim();
  if (new RegExp(`^${escapeRegExp(sectionNumber)}(?:\\s|[：:、.．])`).test(segment)) return block;
  const numberPattern = new RegExp(`(?<![\\d.])${escapeRegExp(sectionNumber)}(?![\\d.])`);
  if (!numberPattern.test(segment)) return block;
  const withoutNumber = segment.replace(numberPattern, '').replace(/\s{2,}/g, ' ').trim();
  const normalized = `${sectionNumber} ${withoutNumber}`.trim();
  const alignmentGroups = block.alignmentGroups.map((group) => ({
    ...group,
    sourceSentenceIds: [...group.sourceSentenceIds],
    targetSegments: group.targetSegments.map(() => normalized),
  }));
  return { ...block, translation: normalized, alignmentGroups };
}

/**
 * Last-resort deterministic repair after opaque markers have been restored.
 * Some providers rewrite a marker into visually similar Unicode before it
 * reaches the protocol parser.  In that case the marker-level repair cannot
 * see it, but the original source token is still known here.  Reinsert only
 * missing protected occurrences into their aligned sentence; all other
 * validation (block order, source mapping and target reconstruction) remains
 * strict, so this cannot turn an empty or structurally invalid response into a
 * valid translation.
 */
export function restoreMissingProtectedTokensFromTranslation(
  sourceBlocks: readonly TranslationBlockRequest[],
  response: TranslationResponse,
): TranslationResponse {
  const sources = new Map(sourceBlocks.map((block) => [block.blockId, block]));
  return {
    blocks: response.blocks.map((block) => {
      const source = sources.get(block.blockId);
      if (!source) return block;
      const alignmentGroups = block.alignmentGroups.map((group) => ({
        ...group,
        sourceSentenceIds: [...group.sourceSentenceIds],
        targetSegments: [...group.targetSegments],
      }));
      let changed = false;
      const tokens = uniqueInOrder([...source.protectedTokens, ...extractProtectedTokens(source.source)]);
      for (const token of tokens) {
        const required = requiredProtectedOccurrenceCount(source, token);
        const received = translatedProtectedOccurrenceCount(source.source, block.translation, token);
        let missing = Math.max(0, required - received);
        if (!missing) continue;

        const sentenceIds: string[] = [];
        for (const sentence of source.sourceSentences) {
          const count = protectedOccurrenceCount(sentence.text, token);
          for (let index = 0; index < count; index += 1) sentenceIds.push(sentence.id);
        }
        const fallbackId = sentenceIds.at(-1) ?? source.sourceSentences.at(-1)?.id;
        while (sentenceIds.length < required && fallbackId) sentenceIds.push(fallbackId);
        const destinations = sentenceIds.slice(Math.max(0, sentenceIds.length - missing));

        for (const sentenceId of destinations) {
          const group = alignmentGroups.find((candidate) => (
            sentenceId ? candidate.sourceSentenceIds.includes(sentenceId) : false
          )) ?? alignmentGroups.at(-1);
          if (!group?.targetSegments.length) break;
          const sourceIndex = sentenceId ? group.sourceSentenceIds.indexOf(sentenceId) : -1;
          const segmentIndex = sourceIndex < 0
            ? group.targetSegments.length - 1
            : group.targetSegments.length === group.sourceSentenceIds.length
              ? sourceIndex
              : Math.min(
                group.targetSegments.length - 1,
                Math.floor(sourceIndex * group.targetSegments.length / group.sourceSentenceIds.length),
              );
          group.targetSegments[segmentIndex] = insertProtectedToken(group.targetSegments[segmentIndex]!, token);
          missing -= 1;
          changed = true;
          if (!missing) break;
        }
      }
      const repaired = !changed ? block : {
        ...block,
        alignmentGroups,
        translation: alignmentGroups.flatMap((group) => group.targetSegments).join(''),
      };
      return restoreLeadingHeadingNumber(source, repaired);
    }),
  };
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function occurrenceCount(text: string, token: string): number {
  if (!token) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= text.length - token.length) {
    const found = text.indexOf(token, offset);
    if (found < 0) break;
    count += 1;
    offset = found + token.length;
  }
  return count;
}

function protectedOccurrenceCount(text: string, token: string): number {
  const extracted = extractProtectedTokens(text);
  if (CITATION_TOKEN_PATTERN.test(token)) {
    const canonical = token.replace(/\s+/g, '');
    return extracted
      .filter((candidate) => CITATION_TOKEN_PATTERN.test(candidate))
      .filter((candidate) => candidate.replace(/\s+/g, '') === canonical)
      .length;
  }
  if (NUMERIC_TOKEN_PATTERN.test(token) || /^⟦[^⟧]+⟧$/.test(token)) {
    return extracted.filter((candidate) => candidate === token).length;
  }
  // Explicit protected title terms and product names are ordinary literals,
  // not members of the numeric/citation extraction grammar.
  return occurrenceCount(text, token);
}

function sourceUsesFlattenedUnitExponent(source: string, token: string): boolean {
  if (!(token in SUPERSCRIPT_EXPONENT)) return false;
  return Array.from(source.matchAll(FLATTENED_UNIT_EXPONENT_PATTERN))
    .some((match) => match[1] === token);
}

function translatedProtectedOccurrenceCount(source: string, translation: string, token: string): number {
  const count = protectedOccurrenceCount(translation, token);
  if (!sourceUsesFlattenedUnitExponent(source, token)) return count;
  return count + occurrenceCount(translation, SUPERSCRIPT_EXPONENT[token]);
}

function normalizeTargetText(text: string): string {
  return text.normalize('NFKC').replace(/[\s\u3000]+/g, '');
}

const ENGLISH_FUNCTION_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from', 'has', 'have',
  'in', 'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their', 'these', 'this',
  'to', 'was', 'were', 'which', 'with',
]);

function requiresChineseTarget(source: TranslationBlockRequest): boolean {
  if (source.kind === 'author' || /[\u3400-\u9fff]/u.test(source.source)) return false;
  const words = source.source.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
  if (words.length < 5) return false;
  return words.some((word) => ENGLISH_FUNCTION_WORDS.has(word.toLowerCase()));
}

function protectedTokenSequence(text: string, tokens: readonly string[]): string[] {
  const unique = uniqueInOrder([...tokens]).sort((left, right) => right.length - left.length);
  if (!unique.length) return [];
  const pattern = new RegExp(unique.map(escapeRegExp).join('|'), 'gu');
  return Array.from(text.matchAll(pattern), (match) => match[0]!);
}

function isCitationAnchoredSourceTerm(source: string, word: string): boolean {
  // Lowercase software and library names are common in papers (for example a
  // package name immediately followed by its citation).  They are supposed to
  // remain verbatim in Chinese, but the residual-English guard cannot infer
  // that from casing alone.  A source-side citation directly attached to the
  // same token is deterministic evidence that it is a referenced term, not a
  // piece of prose accidentally left untranslated.
  const anchored = new RegExp(
    `\\b${escapeRegExp(word)}\\b\\s*(?:[,;:]\\s*)?\\[\\s*\\d+(?:\\s*[-,]\\s*\\d+)*\\s*\\]`,
    'u',
  );
  return anchored.test(source);
}

function untranslatedLowercaseWords(source: TranslationBlockRequest, translation: string): string[] {
  if (!requiresChineseTarget(source)) return [];
  const prose = translation
    .replace(/https?:\/\/\S+|\b\S+@\S+\b/giu, ' ')
    .replace(/[（(][^()（）]{0,240}[）)]/gu, ' ');
  return [...new Set(prose.match(/\b[a-z]{8,}(?:-[a-z]{4,})*\b/gu) ?? [])]
    .filter((word) => !isCitationAnchoredSourceTerm(source.source, word));
}

function validateSourceMapping(
  source: TranslationBlockRequest,
  response: TranslationBlockResponse,
): boolean {
  const expectedIds = source.sourceSentences.map((sentence) => sentence.id);
  const actualIds = response.alignmentGroups.flatMap((group) => group.sourceSentenceIds);
  if (expectedIds.length !== actualIds.length) return false;
  if (response.alignmentGroups.some((group) => (
    group.sourceSentenceIds.length === 0
    || group.targetSegments.length === 0
    || group.targetSegments.some((segment) => segment.trim().length === 0)
  ))) return false;
  return expectedIds.every((id, index) => actualIds[index] === id);
}

function addIssue(
  issues: TranslationValidationIssue[],
  blockId: string,
  code: string,
  message: string,
): void {
  issues.push({ blockId, code, message });
}

export function validateBatchResponse(
  sourceBlocks: TranslationBlockRequest[],
  response: TranslationResponse,
): TranslationValidationResult {
  const issues: TranslationValidationIssue[] = [];
  const accepted: TranslationBlockResponse[] = [];
  const expectedBlockIds = sourceBlocks.map((block) => block.blockId);
  const actualBlockIds = response.blocks.map((block) => block.blockId);

  const envelopeMatches = !(
    expectedBlockIds.length !== actualBlockIds.length
    || expectedBlockIds.some((id, index) => actualBlockIds[index] !== id)
  );
  const safePartialPrefix = actualBlockIds.length <= expectedBlockIds.length
    && actualBlockIds.every((id, index) => expectedBlockIds[index] === id);
  if (!envelopeMatches) {
    addIssue(issues, '*', 'block-id-mismatch', 'Response block IDs or order do not match the request.');
  }

  for (const [index, source] of sourceBlocks.entries()) {
    const translated = response.blocks[index];
    const issueStart = issues.length;
    if (!translated || translated.blockId !== source.blockId) continue;

    if (!translated.translation.trim()) {
      addIssue(issues, source.blockId, 'translation-empty', 'Translation is empty.');
    }

    if (requiresChineseTarget(source)
      && (translated.translation.match(/[\u3400-\u9fff]/gu)?.length ?? 0) < 2) {
      addIssue(
        issues,
        source.blockId,
        'target-language-missing',
        'English natural-language source must contain a substantive Chinese translation.',
      );
    }

    const protectedTokens = uniqueInOrder([
      ...source.protectedTokens,
      ...extractProtectedTokens(source.source),
    ]);
    for (const token of protectedTokens) {
      const required = requiredProtectedOccurrenceCount(source, token);
      const received = translatedProtectedOccurrenceCount(source.source, translated.translation, token);
      // A natural translation may render an English number word ("one",
      // "second") as an Arabic numeral. That produces an additional complete
      // numeric token without changing any protected source numeral. Citations
      // and explicit protected markers still require exact multiplicity.
      const changed = NUMERIC_TOKEN_PATTERN.test(token)
        ? received < required
        : received !== required;
      if (changed) {
        addIssue(
          issues,
          source.blockId,
          'protected-token-changed',
          `Protected token count changed for ${token} (expected at least ${required}, received ${received}).`,
        );
      }
    }

    if (source.kind === 'title') {
      const sourceSequence = protectedTokenSequence(source.source, protectedTokens);
      const targetSequence = protectedTokenSequence(translated.translation, protectedTokens);
      if (sourceSequence.join('\u0000') !== targetSequence.join('\u0000')) {
        addIssue(
          issues,
          source.blockId,
          'protected-token-order-changed',
          'Title protected tokens must remain in source order, including the trailing footnote marker.',
        );
      }
    }

    const untranslatedWords = untranslatedLowercaseWords(source, translated.translation);
    if (untranslatedWords.length) {
      addIssue(
        issues,
        source.blockId,
        'untranslated-residual',
        `Chinese target contains untranslated lowercase prose: ${untranslatedWords.slice(0, 5).join(', ')}.`,
      );
    }

    if (!validateSourceMapping(source, translated)) {
      addIssue(
        issues,
        source.blockId,
        'source-mapping-invalid',
        'Source sentence IDs must be covered exactly once in source order.',
      );
    }

    const targetFromSegments = translated.alignmentGroups
      .flatMap((group) => group.targetSegments)
      .join('');
    if (normalizeTargetText(targetFromSegments) !== normalizeTargetText(translated.translation)) {
      addIssue(
        issues,
        source.blockId,
        'target-segments-mismatch',
        'Target segments do not reconstruct the block translation.',
      );
    }

    // A truncated response may safely commit its independently validated
    // leading blocks and retry only the missing suffix. Extra, duplicated, or
    // reordered blocks are not a safe prefix and must commit nothing.
    if (safePartialPrefix && issues.length === issueStart) accepted.push(translated);
  }

  return { ok: issues.length === 0, accepted, issues };
}
