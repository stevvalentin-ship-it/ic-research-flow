export type GlossarySourceType = 'model' | 'detected' | 'user';

export interface GlossaryTerm {
  source: string;
  target: string;
  abbreviation?: string;
}

export interface ResolvedGlossaryTerm extends GlossaryTerm {
  sourceType: GlossarySourceType;
}

export interface GlossarySources {
  detected: GlossaryTerm[];
  model: GlossaryTerm[];
  user: GlossaryTerm[];
}

function normalizeTerm(term: string): string {
  return term.normalize('NFKC').toLocaleLowerCase().trim();
}

export function mergeGlossary(sources: GlossarySources): ResolvedGlossaryTerm[] {
  const merged = new Map<string, ResolvedGlossaryTerm>();
  const add = (terms: GlossaryTerm[], sourceType: GlossarySourceType) => {
    for (const term of terms) {
      const key = normalizeTerm(term.source);
      if (!key) continue;
      merged.set(key, { ...term, sourceType });
    }
  };

  add(sources.model, 'model');
  add(sources.detected, 'detected');
  add(sources.user, 'user');
  return Array.from(merged.values());
}

export interface TerminologyTextBlock {
  blockId: string;
  source: string;
}

export type MarkedTerminologyBlock<T extends TerminologyTextBlock> = T & { firstTermIds: string[] };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsWholeTerm(text: string, source: string): boolean {
  const normalizedText = text.normalize('NFKC').toLocaleLowerCase();
  const normalizedSource = normalizeTerm(source);
  if (!normalizedSource) return false;
  const boundary = '[^\\p{L}\\p{N}_]';
  return new RegExp(`(?:^|${boundary})${escapeRegExp(normalizedSource)}(?=$|${boundary})`, 'u')
    .test(normalizedText);
}

export function markFirstOccurrences<T extends TerminologyTextBlock>(
  blocks: readonly T[],
  glossary: readonly GlossaryTerm[],
): Array<MarkedTerminologyBlock<T>> {
  const seen = new Set<string>();
  return blocks.map((block) => {
    const firstTermIds: string[] = [];
    for (const term of glossary) {
      const termId = normalizeTerm(term.source);
      if (!termId || seen.has(termId) || !containsWholeTerm(block.source, term.source)) continue;
      seen.add(termId);
      firstTermIds.push(termId);
    }
    return { ...block, firstTermIds };
  });
}
