// @vitest-environment node

import { PDFDocument, StandardFonts } from 'pdf-lib'
import { parsePdf } from './pdfParser'

describe('parsePdf', () => {
  it('extracts text and page count from a real text PDF', async () => {
    const document = await PDFDocument.create()
    const page = document.addPage([400, 400])
    const font = await document.embedFont(StandardFonts.Helvetica)
    page.drawText('Chiplet thermal management with TSV optimization', { x: 30, y: 340, font, size: 12 })
    const bytes = await document.save()
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    const file = new File([buffer], 'chiplet.pdf', { type: 'application/pdf' })

    const parsed = await parsePdf(file)

    expect(parsed.pageCount).toBe(1)
    expect(parsed.fullText).toContain('Chiplet thermal management')
  }, 15_000)
})
