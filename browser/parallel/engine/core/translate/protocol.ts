export type TranslationBlockKind =
  | 'title'
  | 'author'
  | 'affiliation'
  | 'abstract'
  | 'heading'
  | 'paragraph'
  | 'list-item'
  | 'caption'
  | 'table-title';

export interface SourceSentenceCandidate {
  id: string;
  text: string;
}

export interface TranslationBlockRequest {
  blockId: string;
  kind: TranslationBlockKind;
  source: string;
  alignmentMode: 'sentence-candidates' | 'paragraph-fallback';
  sourceSentences: SourceSentenceCandidate[];
  protectedTokens: string[];
}

export interface TranslationAlignmentGroup {
  sourceSentenceIds: string[];
  targetSegments: string[];
}

export interface TranslationBlockResponse {
  blockId: string;
  translation: string;
  alignmentGroups: TranslationAlignmentGroup[];
  newTerms: Array<{ source: string; target: string; abbreviation?: string }>;
  warnings: string[];
}

export interface TranslationResponse {
  blocks: TranslationBlockResponse[];
}

export interface TranslationRequest {
  documentContext: {
    title: string;
    abstract?: string;
    detectedFields: string[];
    sectionPath: string;
  };
  terminologyPolicy: {
    firstOccurrence: string;
    laterOccurrence: string;
  };
  entityPolicy: {
    authorNames: 'keep';
    organizationNames: 'keep' | 'translate_when_clear';
    modelNames: 'keep';
    productNames: 'keep';
  };
  glossary: Array<{ source: string; target: string; abbreviation?: string }>;
  recoveryContext?: {
    reason: 'output-limit' | 'validation';
    validationCodes: string[];
    validationDetails: string[];
  };
  blocks: TranslationBlockRequest[];
}

export interface TranslationValidationIssue {
  blockId: string;
  code: string;
  message: string;
}

export interface TranslationValidationResult {
  ok: boolean;
  accepted: TranslationBlockResponse[];
  issues: TranslationValidationIssue[];
}
