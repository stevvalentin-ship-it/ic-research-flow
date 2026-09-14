import type { Rect } from '../../types/models';
import { awaitWithDeadline } from '../task/asyncDeadline';

export const ASSET_CROP_RENDER_VERSION = 'pdfjs-region-bounded-v2';

interface PdfViewportLike { width: number; height: number }
interface PdfRenderTaskLike { promise: Promise<unknown>; cancel?(): void }
export interface RenderablePdfPage {
  getViewport(options: { scale: number }): PdfViewportLike;
  render(options: {
    canvasContext: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    viewport: PdfViewportLike;
    transform?: number[];
    background?: string;
    intent?: 'print';
  }): PdfRenderTaskLike;
}

export interface CropPageRegionOptions {
  signal?: AbortSignal;
  /** Covers both rendering and PNG encoding. */
  timeoutMs?: number;
  /** Maximum pixels per canvas; masked crops require at most two such canvases. */
  maxPixels?: number;
  maxDimension?: number;
}

type CanvasTarget = HTMLCanvasElement | OffscreenCanvas;

function createCanvas(width: number, height: number): CanvasTarget {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('Canvas is unavailable in this browser');
}

function context2d(canvas: CanvasTarget): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to create a 2D canvas context');
  return context as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

function exportPng(canvas: CanvasTarget): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/png' });
  }
  const htmlCanvas = canvas as HTMLCanvasElement;
  return new Promise((resolve, reject) => {
    htmlCanvas.toBlob((blob: Blob | null) => {
      if (blob) resolve(blob);
      else reject(new Error('Unable to encode immutable PNG asset'));
    }, 'image/png');
  });
}

export async function cropPageRegionLossless(
  page: RenderablePdfPage,
  rect: Rect,
  scale = 4,
  eraseRects: readonly Rect[] = [],
  preserveRects: readonly Rect[] = [],
  options: CropPageRegionOptions = {},
): Promise<Blob> {
  if (options.signal?.aborted) throw new DOMException('任务已停止', 'AbortError');
  const maxPixels = options.maxPixels ?? 8_000_000;
  const maxDimension = options.maxDimension ?? 8192;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (![rect.x, rect.y, rect.w, rect.h, scale, maxPixels, maxDimension, timeoutMs].every(Number.isFinite)
    || rect.w <= 0 || rect.h <= 0 || scale <= 0 || maxPixels < 1 || maxDimension < 1 || timeoutMs <= 0) {
    throw new Error('裁图范围、缩放和资源上限必须有效');
  }
  // Rasterize the requested region, not a full high-resolution page for every asset.
  let renderScale = Math.min(scale, Math.sqrt(maxPixels / (rect.w * rect.h)), maxDimension / rect.w, maxDimension / rect.h);
  if (!Number.isFinite(renderScale) || renderScale <= 0) throw new Error('裁图区域超出可渲染范围');
  const dimensions = () => ({
    width: Math.max(1, Math.ceil((rect.x + rect.w) * renderScale) - Math.floor(rect.x * renderScale)),
    height: Math.max(1, Math.ceil((rect.y + rect.h) * renderScale) - Math.floor(rect.y * renderScale)),
  });
  let { width: cropWidth, height: cropHeight } = dimensions();
  for (let attempt = 0; cropWidth * cropHeight > maxPixels || cropWidth > maxDimension || cropHeight > maxDimension; attempt += 1) {
    if (attempt >= 32) throw new Error('裁图区域无法满足图像资源上限');
    renderScale *= Math.min(0.95, Math.sqrt(maxPixels / (cropWidth * cropHeight)), maxDimension / cropWidth, maxDimension / cropHeight);
    ({ width: cropWidth, height: cropHeight } = dimensions());
  }
  const viewport = page.getViewport({ scale: renderScale });
  const sourceX = Math.floor(rect.x * renderScale);
  const sourceY = Math.floor(rect.y * renderScale);
  const source = createCanvas(cropWidth, cropHeight);
  let target: CanvasTarget = source;
  let renderTask: PdfRenderTaskLike | undefined;
  const startedAt = Date.now();
  const wait = <T>(operation: Promise<T>): Promise<T> => awaitWithDeadline(operation, {
    signal: options.signal,
    timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)),
    timeoutMessage: 'PDF 局部裁图或图像编码超时',
    onCancel: () => renderTask?.cancel?.(),
  });
  try {
    renderTask = page.render({
      canvasContext: context2d(source), viewport,
      transform: [1, 0, 0, 1, -sourceX, -sourceY], background: '#ffffff',
      intent: 'print',
    });
    await wait(renderTask.promise);
    if (preserveRects.length) target = createCanvas(cropWidth, cropHeight);
    const targetContext = context2d(target);
    const pixelsWithinCrop = (area: Rect) => {
      const left = Math.max(rect.x, area.x);
      const top = Math.max(rect.y, area.y);
      const right = Math.min(rect.x + rect.w, area.x + area.w);
      const bottom = Math.min(rect.y + rect.h, area.y + area.h);
      if (right <= left || bottom <= top) return undefined;
      const x = Math.max(0, Math.floor(left * renderScale) - sourceX);
      const y = Math.max(0, Math.floor(top * renderScale) - sourceY);
      return {
        x, y,
        w: Math.min(cropWidth, Math.ceil(right * renderScale) - sourceX) - x,
        h: Math.min(cropHeight, Math.ceil(bottom * renderScale) - sourceY) - y,
      };
    };
    if (preserveRects.length) {
      targetContext.fillStyle = '#ffffff';
      targetContext.fillRect(0, 0, cropWidth, cropHeight);
      for (const preserve of preserveRects) {
        const pixels = pixelsWithinCrop(preserve);
        if (!pixels || pixels.w <= 0 || pixels.h <= 0) continue;
        const { x, y, w, h } = pixels;
        targetContext.drawImage(source, x, y, w, h, x, y, w, h);
      }
    } else if (eraseRects.length) {
      targetContext.save();
      targetContext.fillStyle = '#ffffff';
      for (const erase of eraseRects) {
        const pixels = pixelsWithinCrop(erase);
        if (!pixels || pixels.w <= 0 || pixels.h <= 0) continue;
        targetContext.fillRect(pixels.x, pixels.y, pixels.w, pixels.h);
      }
      targetContext.restore();
    }
    return await wait(exportPng(target));
  } finally {
    source.width = 0;
    source.height = 0;
    if (target !== source) {
      target.width = 0;
      target.height = 0;
    }
  }
}
