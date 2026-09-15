import type { AlignmentRectSet, Rect } from '../../types/models';

const MARKER_PREFIX = 'https://paper-parallel.invalid/unit/';

interface AnnotationLike {
  url?: string;
  rect?: number[];
}

interface MarkerPageLike {
  getViewport(options: { scale: number }): {
    convertToViewportRectangle?(rect: number[]): number[];
  };
  getAnnotations(options: { intent: 'display' }): Promise<AnnotationLike[]>;
}

export interface MarkerPdfLike {
  numPages: number;
  getPage(pageNumber: number): Promise<MarkerPageLike>;
}

function viewportRect(values: number[]): Rect | null {
  if (values.length < 4 || values.slice(0, 4).some((value) => !Number.isFinite(value))) return null;
  const [x1, y1, x2, y2] = values;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

export async function readTargetMarkers(
  pdf: MarkerPdfLike,
): Promise<Map<string, AlignmentRectSet[]>> {
  const grouped = new Map<string, Map<number, Rect[]>>();
  for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const annotations = await page.getAnnotations({ intent: 'display' });
    for (const annotation of annotations) {
      if (!annotation.url?.startsWith(MARKER_PREFIX) || !annotation.rect) continue;
      const encodedId = annotation.url.slice(MARKER_PREFIX.length);
      if (!encodedId) continue;
      let id: string;
      try {
        id = decodeURIComponent(encodedId);
      } catch {
        continue;
      }
      const converted = viewport.convertToViewportRectangle
        ? viewport.convertToViewportRectangle(annotation.rect)
        : annotation.rect;
      const rect = viewportRect(converted);
      if (!rect) continue;
      const pages = grouped.get(id) ?? new Map<number, Rect[]>();
      const rects = pages.get(pageIndex) ?? [];
      rects.push(rect);
      pages.set(pageIndex, rects);
      grouped.set(id, pages);
    }
  }

  return new Map([...grouped.entries()].map(([id, pages]) => [
    id,
    [...pages.entries()]
      .sort(([left], [right]) => left - right)
      .map(([page, rects]) => ({ page, rects })),
  ]));
}
