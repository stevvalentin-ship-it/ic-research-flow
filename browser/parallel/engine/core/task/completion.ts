export interface CompletionSummary {
  requiredBlocks: number;
  validatedBlocks: number;
  failedBlocks: number;
  protectedContentPass: boolean;
  pdfCompiled: boolean;
  assetsPass: boolean;
  alignmentBuilt: boolean;
  persisted: boolean;
}

export function canEnterReader(summary: CompletionSummary): boolean {
  return summary.requiredBlocks > 0
    && summary.validatedBlocks === summary.requiredBlocks
    && summary.failedBlocks === 0
    && summary.protectedContentPass
    && summary.pdfCompiled
    && summary.assetsPass
    && summary.alignmentBuilt
    && summary.persisted;
}
