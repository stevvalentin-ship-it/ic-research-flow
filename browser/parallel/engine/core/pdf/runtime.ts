import { GlobalWorkerOptions, getDocument, OPS } from 'paper-parallel-pdfjs';
import workerUrl from 'paper-parallel-pdfjs/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

export { getDocument, OPS };
export type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'paper-parallel-pdfjs';
