export interface ThroughputSample {
  tokens: number;
  elapsedMs: number;
}

export function estimateRemainingMs(
  samples: readonly ThroughputSample[],
  remainingTokens: number,
): number | null {
  const recent = samples
    .filter((sample) => sample.tokens > 0 && sample.elapsedMs > 0)
    .slice(-8);
  if (recent.length < 2) return null;

  const millisecondsPerToken = recent
    .map((sample) => sample.elapsedMs / sample.tokens)
    .sort((left, right) => left - right);
  const middle = Math.floor(millisecondsPerToken.length / 2);
  const median = millisecondsPerToken.length % 2 === 0
    ? (millisecondsPerToken[middle - 1]! + millisecondsPerToken[middle]!) / 2
    : millisecondsPerToken[middle]!;
  return Math.round(Math.max(0, remainingTokens) * median);
}
