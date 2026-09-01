import { tokenizeIcText } from './tokenize'

describe('tokenizeIcText', () => {
  it('normalizes Chinese and English chiplet terminology', () => {
    const tokens = tokenizeIcText('芯粒 die-to-die UCIe 2.5D互连')
    expect(tokens).toEqual(expect.arrayContaining(['chiplet', 'die-to-die', 'ucie', '2.5d', '互连']))
  })
})
