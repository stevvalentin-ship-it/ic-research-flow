export interface ScoreFeatures {
  relevance: number
  influence: number
  frontier: number
  evidence: number
  bridge: number
}

export function scorePaper(features: ScoreFeatures): number {
  return 0.4 * features.relevance
    + 0.3 * features.influence
    + 0.15 * features.frontier
    + 0.1 * features.evidence
    + 0.05 * features.bridge
}
