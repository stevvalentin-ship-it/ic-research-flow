import { fingerprintFile } from './fileFingerprint'

describe('fingerprintFile', () => {
  it('uses file content rather than the filename for deduplication', async () => {
    const first = new File(['same paper'], 'first.pdf', { type: 'application/pdf' })
    const renamed = new File(['same paper'], 'renamed.pdf', { type: 'application/pdf' })
    const different = new File(['different paper'], 'first.pdf', { type: 'application/pdf' })

    expect(await fingerprintFile(first)).toBe(await fingerprintFile(renamed))
    expect(await fingerprintFile(first)).not.toBe(await fingerprintFile(different))
  })
})
