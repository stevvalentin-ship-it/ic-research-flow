import { splitSentences } from './index';
import type { SourceSentenceCandidate } from '../translate/protocol';

export interface SourceSentenceCandidateResult {
  mode: 'sentence-candidates' | 'paragraph-fallback';
  sentences: SourceSentenceCandidate[];
  fallbackReason?: 'sentence-boundary-ambiguous';
}

function normalizeCoverageText(text: string): string {
  return text.normalize('NFKC').replace(/[\s\u3000]+/g, '');
}

function isTechnicalPunctuationAmbiguous(text: string): boolean {
  return /[_=]/.test(text) && /[:;；]/.test(text);
}

export function buildSourceSentenceCandidates(
  blockId: string,
  text: string,
): SourceSentenceCandidateResult {
  const source = text.trim();
  const sentenceInput = source.replace(/\s*\n+\s*/g, ' ');
  const parts = splitSentences(sentenceInput);
  const sourceNormalized = normalizeCoverageText(source);
  const reconstructed = normalizeCoverageText(parts.join(''));
  const coverage = sourceNormalized.length === 0
    ? 1
    : Math.min(reconstructed.length, sourceNormalized.length) / sourceNormalized.length;
  const reliable = parts.length > 0
    && coverage >= 0.98
    && reconstructed === sourceNormalized
    && !isTechnicalPunctuationAmbiguous(source);

  if (!reliable) {
    return {
      mode: 'paragraph-fallback',
      sentences: [{ id: blockId, text: source }],
      fallbackReason: 'sentence-boundary-ambiguous',
    };
  }

  return {
    mode: 'sentence-candidates',
    sentences: parts.map((sentence, index) => ({
      id: `${blockId}-s-${index + 1}`,
      text: sentence,
    })),
  };
}
