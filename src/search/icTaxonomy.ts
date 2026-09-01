export const IC_SYNONYMS: Record<string, string> = {
  芯粒: 'chiplet',
  小芯片: 'chiplet',
  芯片间: 'die-to-die',
  硅通孔: 'tsv',
  贯穿硅通孔: 'tsv',
  存算一体: 'compute-in-memory',
  近存计算: 'near-memory-computing',
  先进封装: 'advanced-packaging',
  三维集成: '3d-integration',
}

export const IC_QUERY_EXPANSIONS: Record<string, string[]> = {
  chiplet: ['die-to-die', 'ucie', '2.5d', '3d-integration', 'advanced-packaging'],
  tsv: ['through-silicon-via', 'thermal', '3d-integration'],
  eda: ['placement', 'routing', 'verification', 'synthesis'],
  cmos: ['mosfet', 'vlsi', 'integrated-circuit'],
}
