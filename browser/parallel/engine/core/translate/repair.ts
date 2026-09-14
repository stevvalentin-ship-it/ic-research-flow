import type {
  TranslationBlockRequest,
  TranslationBlockResponse,
  TranslationResponse,
} from './protocol';
import { extractProtectedTokens } from './protected';

const REPAIR_CHUNK_MAX_CHARS = 340;
const REPAIR_CHUNK_MIN_BREAK = 120;

function splitAtNaturalBoundaries(source: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    const remaining = source.length - offset;
    if (remaining <= REPAIR_CHUNK_MAX_CHARS) {
      chunks.push(source.slice(offset));
      break;
    }
    const window = source.slice(offset, offset + REPAIR_CHUNK_MAX_CHARS);
    const minimum = Math.min(REPAIR_CHUNK_MIN_BREAK, window.length - 1);
    let cut = -1;
    for (let index = window.length - 1; index >= minimum; index -= 1) {
      if (/\s/.test(window[index] ?? '') && /[.!?;:]\s*$/.test(window.slice(0, index))) {
        cut = index + 1;
        break;
      }
    }
    if (cut < 0) {
      for (let index = window.length - 1; index >= minimum; index -= 1) {
        if (/\s/.test(window[index] ?? '')) {
          cut = index + 1;
          break;
        }
      }
    }
    if (cut < 1) cut = window.length;
    chunks.push(source.slice(offset, offset + cut));
    offset += cut;
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

export interface TranslationRepairPlan {
  blocks: TranslationBlockRequest[];
  merge(response: TranslationResponse): TranslationResponse;
}

export function buildSingleBlockRepairPlan(block: TranslationBlockRequest): TranslationRepairPlan | undefined {
  const chunks = splitAtNaturalBoundaries(block.source);
  if (chunks.length <= 1) return undefined;
  const blocks = chunks.map((source, index): TranslationBlockRequest => {
    const blockId = `${block.blockId}::repair-${index + 1}`;
    return {
      blockId,
      kind: block.kind,
      source,
      alignmentMode: 'paragraph-fallback',
      sourceSentences: [{ id: `${blockId}-source`, text: source }],
      protectedTokens: extractProtectedTokens(source),
    };
  });

  return {
    blocks,
    merge(response): TranslationResponse {
      if (
        response.blocks.length !== blocks.length
        || response.blocks.some((item, index) => item.blockId !== blocks[index]?.blockId)
      ) {
        throw new Error('DeepSeek 分片修复响应与请求片段不一致');
      }
      const translations = response.blocks.map((item) => item.translation);
      const merged: TranslationBlockResponse = {
        blockId: block.blockId,
        translation: translations.join('\n'),
        alignmentGroups: [{
          sourceSentenceIds: block.sourceSentences.map((sentence) => sentence.id),
          targetSegments: translations,
        }],
        newTerms: response.blocks.flatMap((item) => item.newTerms),
        warnings: response.blocks.flatMap((item) => item.warnings),
      };
      return { blocks: [merged] };
    },
  };
}
