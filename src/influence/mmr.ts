export interface MmrCandidate {
  id: string
  score: number
  domains: string[]
  terms: string[]
}

function similarity(a: MmrCandidate, b: MmrCandidate): number {
  const left = new Set([...a.domains.map((item) => `d:${item}`), ...a.terms.map((item) => `t:${item}`)])
  const right = new Set([...b.domains.map((item) => `d:${item}`), ...b.terms.map((item) => `t:${item}`)])
  const intersection = [...left].filter((item) => right.has(item)).length
  const union = new Set([...left, ...right]).size
  return union ? intersection / union : 0
}

export function selectDiverseCorePapers<T extends MmrCandidate>(candidates: T[], count = 15, lambda = 0.72): T[] {
  const remaining = [...candidates].sort((a, b) => b.score - a.score)
  const selected: T[] = []
  while (remaining.length && selected.length < Math.min(15, Math.max(1, count))) {
    let bestIndex = 0
    let bestValue = -Infinity
    remaining.forEach((candidate, index) => {
      const redundancy = selected.length ? Math.max(...selected.map((chosen) => similarity(candidate, chosen))) : 0
      const value = lambda * candidate.score - (1 - lambda) * redundancy
      if (value > bestValue) { bestValue = value; bestIndex = index }
    })
    selected.push(remaining.splice(bestIndex, 1)[0])
  }
  return selected
}
