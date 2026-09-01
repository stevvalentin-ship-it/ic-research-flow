import { scorePaper } from './scoring'

describe('scorePaper', () => {
  it('uses the documented IC influence weights', () => {
    expect(scorePaper({ relevance: 1, influence: 0.8, frontier: 0.6, evidence: 0.4, bridge: 0.2 }))
      .toBeCloseTo(0.4 + 0.24 + 0.09 + 0.04 + 0.01)
  })
})
