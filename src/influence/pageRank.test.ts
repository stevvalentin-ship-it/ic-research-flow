import { personalizedPageRank } from './pageRank'

describe('personalizedPageRank', () => {
  it('ranks a paper cited by two relevant papers above an isolated paper', () => {
    const scores = personalizedPageRank({
      nodes: ['a', 'b', 'c', 'd'],
      edges: [{ source: 'a', target: 'c' }, { source: 'b', target: 'c' }],
    }, { a: 0.4, b: 0.3, c: 0.2, d: 0.1 })

    expect(scores.c).toBeGreaterThan(scores.d)
    expect(Object.values(scores).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6)
  })
})
