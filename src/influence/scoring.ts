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


export function normalizePaperScores<T extends { paperId: string; total: number }>(scores: T[]): T[] {
  if (scores.length <= 1) return scores.map((score) => ({ ...score, total: 0.65 }))
  const ordered = [...scores].sort((a, b) => a.total - b.total)
  const rank = new Map(ordered.map((score, index) => [score.paperId, index]))
  const maxRank = ordered.length - 1
  return scores.map((score) => ({ ...score, total: 0.45 + 0.5 * ((rank.get(score.paperId) ?? 0) / maxRank) }))
}
