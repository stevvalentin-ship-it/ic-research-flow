import { selectDiverseCorePapers } from './mmr'

describe('selectDiverseCorePapers', () => {
  it('prefers a second domain over a near duplicate', () => {
    const selected = selectDiverseCorePapers([
      { id: 'a', score: 1, domains: ['chiplet'], terms: ['thermal', 'tsv'] },
      { id: 'b', score: 0.98, domains: ['chiplet'], terms: ['thermal', 'tsv'] },
      { id: 'c', score: 0.9, domains: ['eda'], terms: ['routing', 'placement'] },
    ], 2)

    expect(selected.map((item) => item.id)).toEqual(['a', 'c'])
  })
})
