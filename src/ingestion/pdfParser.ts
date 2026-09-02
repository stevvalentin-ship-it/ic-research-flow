import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { readFile } from './fileFingerprint'

export interface ParsedPdf {
  title: string
  pageCount: number
  pageTexts: string[]
  fullText: string
  isScanned?: boolean
}

export interface PdfPageImage {
  page: number
  dataUrl: string
}

export class PdfParseError extends Error {
  constructor(public readonly code: 'SCANNED_PDF' | 'INVALID_PDF', message: string) {
    super(message)
    this.name = 'PdfParseError'
  }
}

async function loadPdfDocument(file: File): Promise<{
  pdfDocument: import('pdfjs-dist').PDFDocumentProxy
  metadata: { info?: { Title?: string } } | undefined
  destroy: () => Promise<void>
}> {
  const isNode = typeof window === 'undefined'
  const pdfjs = isNode ? await import('pdfjs-dist/legacy/build/pdf.mjs') : await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = isNode
    ? new URL('../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString()
    : pdfWorkerUrl
  const data = new Uint8Array(await readFile(file))
  const loadingTask = pdfjs.getDocument({ data })
  const pdfDocument = await loadingTask.promise
  const metadata = await pdfDocument.getMetadata().catch(() => undefined)
  return { pdfDocument, metadata, destroy: () => loadingTask.destroy() }
}

export async function renderPdfPageAsDataUrl(file: File, pageNumber: number, options: { scale?: number } = {}): Promise<string> {
  const { pdfDocument, destroy } = await loadPdfDocument(file)
  const page = await pdfDocument.getPage(pageNumber)
  try {
    const scale = options.scale ?? 1.5
    const viewport = page.getViewport({ scale })
    const canvas = window.document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法创建页面图像画布')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' }).promise
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    page.cleanup()
    await destroy()
  }
}

export async function parsePdf(file: File): Promise<ParsedPdf> {
  try {
    const { pdfDocument, metadata } = await loadPdfDocument(file)
    const pageTexts: string[] = []
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber)
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
    const isScanned = fullText.replace(/\s/g, '').length < 40
    const info = metadata?.info as { Title?: string } | undefined
    return {
      title: info?.Title?.trim() || file.name.replace(/\.pdf$/i, ''),
      pageCount: pdfDocument.numPages,
      pageTexts,
      fullText,
      isScanned,
    }
  } catch (error) {
    if (error instanceof PdfParseError) throw error
    throw new PdfParseError('INVALID_PDF', error instanceof Error ? error.message : 'Unable to parse PDF')
  }
}
