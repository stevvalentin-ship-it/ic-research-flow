import type {
  AlignmentRelation,
  AlignmentUnit,
  SemanticUnitKind,
} from '../../types/models';
import type {
  SourceSentenceCandidate,
  TranslationAlignmentGroup,
} from '../translate/protocol';

export interface SourceCandidateBlock {
  blockId: string;
  mode: 'sentence-candidates' | 'paragraph-fallback';
  sentences: SourceSentenceCandidate[];
}

export interface OrderedSemanticInput {
  id: string;
  parentId?: string;
  sourceBlockId?: string;
  sourceBlockIds?: string[];
  kind: SemanticUnitKind;
  sourceText?: string;
  translation?: string;
  assetId?: string;
  order: number;
}

function classifyRelation(sourceCount: number, targetCount: number): AlignmentRelation {
  if (sourceCount === 1 && targetCount === 1) return '1:1';
  if (sourceCount === 1 && targetCount > 1) return '1:n';
  if (sourceCount > 1 && targetCount === 1) return 'n:1';
  return 'n:m';
}

function baseUnit(
  input: Pick<AlignmentUnit, 'id' | 'kind' | 'relation' | 'sourceUnitIds' | 'targetUnitIds'>,
): AlignmentUnit {
  return {
    ...input,
    source: [],
    target: [],
    confidence: 0,
    status: 'unmatched',
  };
}

function validateContinuousMappings(
  source: SourceCandidateBlock,
  mappings: TranslationAlignmentGroup[],
): void {
  const indexById = new Map(source.sentences.map((sentence, index) => [sentence.id, index]));
  const consumed = new Set<string>();
  let previousEnd = -1;

  for (const mapping of mappings) {
    if (mapping.sourceSentenceIds.length === 0 || mapping.targetSegments.length === 0) {
      throw new Error(`对齐组 ${source.blockId} 不能为空`);
    }
    const indices = mapping.sourceSentenceIds.map((id) => {
      const index = indexById.get(id);
      if (index === undefined) throw new Error(`对齐组引用未知候选句: ${id}`);
      if (consumed.has(id)) throw new Error(`对齐组重复引用候选句: ${id}`);
      consumed.add(id);
      return index;
    });
    const start = indices[0];
    const end = indices[indices.length - 1];
    const continuous = indices.every((value, offset) => value === start + offset);
    if (!continuous || start !== previousEnd + 1) {
      throw new Error(`对齐组 ${source.blockId} 必须按原文顺序连续映射`);
    }
    previousEnd = end;
  }

  if (consumed.size !== source.sentences.length) {
    throw new Error(`对齐组 ${source.blockId} 未完整覆盖原文候选句`);
  }
}

export function buildSemanticGroups(
  source: SourceCandidateBlock,
  mappings: TranslationAlignmentGroup[],
): AlignmentUnit[] {
  if (source.sentences.length === 0) return [];
  validateContinuousMappings(source, mappings);

  const sourceById = new Map(source.sentences.map((sentence) => [sentence.id, sentence.text]));

  if (source.mode === 'paragraph-fallback') {
    const targetSegments = mappings.flatMap((mapping) => mapping.targetSegments);
    return [{
      ...baseUnit({
        id: source.blockId,
        kind: 'block',
        relation: 'paragraph-fallback',
        sourceUnitIds: [source.blockId],
        targetUnitIds: [`${source.blockId}-t-1`],
      }),
      parentId: source.blockId,
      sourceText: source.sentences.map((sentence) => sentence.text).join(' '),
      targetText: targetSegments.join(''),
      fallbackReason: 'sentence-boundary-ambiguous',
    }];
  }

  return mappings.map((mapping, index) => {
    const id = `${source.blockId}-g-${index + 1}`;
    return {
      ...baseUnit({
        id,
        kind: 'semantic-group',
        relation: classifyRelation(mapping.sourceSentenceIds.length, mapping.targetSegments.length),
        sourceUnitIds: [...mapping.sourceSentenceIds],
        targetUnitIds: mapping.targetSegments.map((_, targetIndex) => `${id}-t-${targetIndex + 1}`),
      }),
      parentId: source.blockId,
      sourceText: mapping.sourceSentenceIds.map((sourceId) => sourceById.get(sourceId)).join(' '),
      targetText: mapping.targetSegments.join(''),
      order: index,
    };
  });
}

export function buildBlockAndAssetAlignmentUnits(
  units: OrderedSemanticInput[],
): AlignmentUnit[] {
  return [...units]
    .sort((left, right) => left.order - right.order)
    .map((unit) => {
      // `assetId` is the authoritative signal. In particular, immutable
      // algorithm/code crops and page furniture are assets too; treating them
      // as ordinary text blocks loses their source crop because no PDF text
      // block exists under the synthetic asset id.
      const isAsset = Boolean(unit.assetId)
        || unit.kind === 'figure'
        || unit.kind === 'table'
        || unit.kind === 'formula'
        || unit.kind === 'code'
        || unit.kind === 'page-furniture';
      const isReference = unit.kind === 'reference';
      const id = isAsset ? (unit.assetId ?? unit.id) : unit.id;
      return {
        ...baseUnit({
          id,
          kind: isAsset ? 'asset' : isReference ? 'reference' : 'block',
          relation: isAsset ? 'asset' : isReference ? 'reference' : 'block',
          sourceUnitIds: [unit.id],
          targetUnitIds: [unit.id],
        }),
        parentId: unit.parentId,
        sourceBlockId: unit.sourceBlockId,
        sourceBlockIds: unit.sourceBlockIds,
        sourceText: unit.sourceText,
        targetText: unit.translation,
        order: unit.order,
      };
    });
}
