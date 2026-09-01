import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { readFile } from './fileFingerprint'

export interface ParsedPdf {
  title: string
  pageCount: number
  pageTexts: string[]
  fullText: string
}

export class PdfParseError extends Error {
  constructor(public readonly code: 'SCANNED_PDF' | 'INVALID_PDF', message: string) {
    super(message)
    this.name = 'PdfParseError'
  }
}

export async function parsePdf(file: File): Promise<ParsedPdf> {
  try {
    const isNode = typeof window === 'undefined'
    const pdfjs = isNode ? await import('pdfjs-dist/legacy/build/pdf.mjs') : await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = isNode
      ? new URL('../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString()
      : pdfWorkerUrl
    const data = new Uint8Array(await readFile(file))
    const document = await pdfjs.getDocument({ data }).promise
    const metadata = await document.getMetadata().catch(() => undefined)
    const pageTexts: string[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items
        .filter((item): item is typeof item & { str: string } => 'str' in item)
        .map((item) => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      pageTexts.push(text)
    }
    const fullText = pageTexts.join('\n\n')
    if (fullText.replace(/\s/g, '').length < 40) {
      throw new PdfParseError('SCANNED_PDF', 'PDF does not contain enough extractable text')
    }
    const info = metadata?.info as { Title?: string } | undefined
    return {
      title: info?.Title?.trim() || file.name.replace(/\.pdf$/i, ''),
      pageCount: document.numPages,
      pageTexts,
      fullText,
    }
  } catch (error) {
    if (error instanceof PdfParseError) throw error
    throw new PdfParseError('INVALID_PDF', error instanceof Error ? error.message : 'Unable to parse PDF')
  }
}
