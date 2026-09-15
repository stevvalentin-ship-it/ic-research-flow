import { AsyncOperationTimeoutError, awaitWithDeadline } from '../task/asyncDeadline';

export interface PdfPageForVision {
  getViewport(input: { scale: number }): { width: number; height: number };
  render(input: { canvasContext: unknown; viewport: unknown; background?: string; intent?: 'print' }): {
    promise: Promise<unknown>;
    cancel?(): void;
  };
  cleanup?(): boolean;
}

export interface VisionCanvas {
  width: number;
  height: number;
  getContext(type: '2d'): {
    fillStyle: string;
    fillRect(x: number, y: number, width: number, height: number): void;
  } | null;
  toDataURL(type: 'image/png'): string;
}

export interface RenderPdfPageOptions {
  scale?: number;
  createCanvas?: () => VisionCanvas;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class PdfPageRenderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`PDF 页面渲染超过 ${Math.ceil(timeoutMs / 1_000)} 秒`);
    this.name = 'PdfPageRenderTimeoutError';
  }
}

function browserCanvas(): VisionCanvas {
  return document.createElement('canvas') as VisionCanvas;
}

export async function renderPdfPageAsPng(
  page: PdfPageForVision,
  options: RenderPdfPageOptions = {},
): Promise<string> {
  if (options.signal?.aborted) throw new DOMException('已停止', 'AbortError');
  const scale = options.scale ?? 2;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const viewport = page.getViewport({ scale });
  const canvas = (options.createCanvas ?? browserCanvas)();
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建页面图像画布');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  // PDF.js display rendering waits for requestAnimationFrame, which can stop
  // in a background tab. Processing images must finish independently of it.
  const renderTask = page.render({ canvasContext: context, viewport, background: '#ffffff', intent: 'print' });
  const cancelRender = () => {
    try { renderTask.cancel?.(); } catch { /* best-effort PDF.js cancellation */ }
  };
  try {
    await awaitWithDeadline(renderTask.promise, { signal: options.signal, timeoutMs, onCancel: cancelRender });
    if (options.signal?.aborted) throw new DOMException('已停止', 'AbortError');
    return canvas.toDataURL('image/png');
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('已停止', 'AbortError');
    if (error instanceof AsyncOperationTimeoutError) throw new PdfPageRenderTimeoutError(timeoutMs);
    throw error;
  } finally {
    try { page.cleanup?.(); } catch { /* release is best-effort */ }
    // Explicitly release the backing bitmap. Waiting for browser GC after dozens
    // of full-page PNGs can otherwise stall the final pages of long papers.
    canvas.width = 0;
    canvas.height = 0;
  }
}
