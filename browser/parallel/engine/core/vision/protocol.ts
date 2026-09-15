export type VisionRegionType =
  | 'figure'
  | 'table'
  | 'display_formula'
  | 'code'
  | 'caption'
  | 'header'
  | 'footer'
  | 'body_text';

export type VisionColumn = 'left' | 'right' | 'full';
export type NormalizedVisionBox = [number, number, number, number];
export type VisionCrossPageHint = 'none' | 'starts' | 'continues' | 'ends' | 'unknown';

export interface VisionRegion {
  type: VisionRegionType;
  /** x, y, width, height in the normalized 0..1000 page coordinate space. */
  bbox: NormalizedVisionBox;
  column: VisionColumn;
  captionBBox?: NormalizedVisionBox;
  confidence: number;
  /** Provider-local identifier retained only as provenance. */
  temporaryId?: string;
  /** Deterministic page-plan identifier assigned by local code. */
  localId?: string;
  visibleLabel?: string;
  captionPosition?: 'above' | 'below' | 'none' | 'unknown';
  /** Model proposal only. Local cross-page evidence remains authoritative. */
  crossPageHint?: VisionCrossPageHint;
  evidence?: string;
}

export interface VisionPageAnalysis {
  pageIndex: number;
  layout: 'single' | 'double' | 'mixed';
  regions: VisionRegion[];
}

export class VisionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionProtocolError';
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
    throw new VisionProtocolError('Vision JSON 无法解析');
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VisionProtocolError(`Vision JSON ${path} 必须为对象`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allow.has(key));
  if (unknown) throw new VisionProtocolError(`Vision JSON ${path} 包含不允许字段 ${unknown}`);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new VisionProtocolError(`Vision JSON ${path} 取值无效`);
  }
  return value as T;
}

export function parseNormalizedVisionBox(value: unknown, path: string): NormalizedVisionBox {
  let values: unknown[];
  if (Array.isArray(value)) {
    values = value;
  } else if (value && typeof value === 'object') {
    const box = value as Record<string, unknown>;
    assertAllowedKeys(box, ['x', 'y', 'width', 'height'], path);
    values = [box.x, box.y, box.width, box.height];
  } else {
    throw new VisionProtocolError(`Vision JSON ${path} 必须为四个有限数字`);
  }
  if (values.length !== 4 || values.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new VisionProtocolError(`Vision JSON ${path} 必须为四个有限数字`);
  }
  let [x, y, width, height] = values as number[];
  if ([x, y, width, height].every((item) => item >= 0 && item <= 1)) {
    [x, y, width, height] = [x * 1000, y * 1000, width * 1000, height * 1000];
  }
  const validXywh = x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1000 && y + height <= 1000;
  if (!validXywh) {
    const [x1, y1, x2, y2] = values as number[];
    const unambiguousXyxy = x1 >= 0 && y1 >= 0 && x2 <= 1000 && y2 <= 1000 && x2 > x1 && y2 > y1;
    if (unambiguousXyxy) {
      [x, y, width, height] = [x1, y1, x2 - x1, y2 - y1];
    }
  }
  // Vision coordinates are estimates, not exact PDF geometry. Some otherwise
  // valid responses overshoot a page edge by a few normalized units (usually
  // because x2/y2 was rounded independently). Intersect only these small
  // excursions with the page; large or fully off-page boxes remain errors so
  // a malformed response cannot silently become an immutable paper asset.
  const edgeTolerance = 100;
  const right = x + width;
  const bottom = y + height;
  const mildlyOutside = x >= -edgeTolerance
    && y >= -edgeTolerance
    && right <= 1000 + edgeTolerance
    && bottom <= 1000 + edgeTolerance;
  if (mildlyOutside && (x < 0 || y < 0 || right > 1000 || bottom > 1000)) {
    const clippedLeft = Math.max(0, x);
    const clippedTop = Math.max(0, y);
    const clippedRight = Math.min(1000, right);
    const clippedBottom = Math.min(1000, bottom);
    [x, y, width, height] = [
      clippedLeft,
      clippedTop,
      clippedRight - clippedLeft,
      clippedBottom - clippedTop,
    ];
  }
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1000 || y + height > 1000) {
    throw new VisionProtocolError(`Vision JSON ${path} 超出 0..1000 页面范围`);
  }
  return [x, y, width, height];
}

function parseLayoutVisionBox(value: unknown, path: string): NormalizedVisionBox {
  // A valid xywh tuple remains authoritative even near a page edge. Inferring
  // xyxy from that location silently truncates legitimate full-width assets.
  // The shared parser repairs only tuples that cannot already be valid xywh.
  return parseNormalizedVisionBox(value, path);
}

function normalizedColumn(value: unknown, bbox: NormalizedVisionBox): VisionColumn {
  if (value === 'left' || value === 'right' || value === 'full') return value;
  const normalized = typeof value === 'string' ? value.toLowerCase().replace(/[ _]/g, '-') : '';
  if (['both', 'span', 'full-width', 'center', 'centre', 'middle'].includes(normalized)) return 'full';
  if (['column-1', 'col-1', 'first-column'].includes(normalized)) return 'left';
  if (['column-2', 'col-2', 'second-column'].includes(normalized)) return 'right';
  if (value !== undefined) throw new VisionProtocolError('Vision JSON region.column 取值无效');
  const [x, , width] = bbox;
  if (width >= 560 || (x < 450 && x + width > 550)) return 'full';
  return x + width / 2 < 500 ? 'left' : 'right';
}

function normalizedConfidence(value: unknown): number | undefined {
  let numeric: number;
  if (typeof value === 'number') {
    numeric = value;
  } else if (Array.isArray(value) && value.length === 1) {
    return normalizedConfidence(value[0]);
  } else if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return normalizedConfidence(
      object.score ?? object.value ?? object.confidence ?? object.percent ?? object.percentage,
    );
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    const qualitative = trimmed.toLocaleLowerCase();
    if (/^(?:very\s+high|high|strong|confident)$/.test(qualitative)) return 0.95;
    if (/^(?:medium|moderate)$/.test(qualitative)) return 0.75;
    if (/^(?:low|weak)$/.test(qualitative)) return 0.5;
    const percentage = trimmed.endsWith('%');
    const ratio = trimmed.match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*100\s*$/);
    if (ratio) return Number(ratio[1]) / 100;
    const numericText = percentage
      ? trimmed.slice(0, -1).trim()
      : trimmed.match(/(?:^|\D)(\d+(?:\.\d+)?)(?:\D|$)/)?.[1] ?? trimmed;
    const parsed = Number(numericText);
    if (!Number.isFinite(parsed)) return undefined;
    numeric = percentage ? parsed / 100 : parsed;
  } else {
    return undefined;
  }
  if (!Number.isFinite(numeric)) return undefined;
  if (numeric > 1 && numeric <= 100) return numeric / 100;
  return numeric;
}

export function parseVisionPageAnalysis(value: unknown, expectedPageIndex: number): VisionPageAnalysis {
  const root = record(parseJson(value), 'root');
  assertAllowedKeys(root, ['page', 'layout', 'regions'], 'root');
  const page = root.page;
  if (!Number.isInteger(page) || page !== expectedPageIndex + 1) {
    throw new VisionProtocolError('Vision JSON page 与请求页面不一致');
  }
  const layout = enumValue(root.layout, ['single', 'double', 'mixed'] as const, 'layout');
  if (!Array.isArray(root.regions)) throw new VisionProtocolError('Vision JSON regions 必须为数组');
  if (root.regions.length > 32) throw new VisionProtocolError('Vision JSON regions 超过单页 32 个上限');

  const regions: VisionRegion[] = [];
  root.regions.forEach((input, index) => {
      const item = record(input, `regions[${index}]`);
      assertAllowedKeys(item, [
        'id', 'type', 'bbox', 'column', 'caption_bbox', 'captionBBox',
        'confidence', 'label', 'visibleLabel', 'caption_position', 'captionPosition',
        'cross_page_hint', 'crossPageHint', 'evidence',
      ], `regions[${index}]`);
      const parsedConfidence = normalizedConfidence(item.confidence);
      // Confidence is advisory metadata. Geometry and semantic-type gates below
      // remain strict, but an unusual provider wrapper (for example
      // {score: 95} or a prose label) must not abort an otherwise usable page.
      // Use a conservative midpoint so local reconciliation can still fall back
      // to the PDF text layer when the region is uncertain.
      const confidence = parsedConfidence !== undefined && parsedConfidence >= 0 && parsedConfidence <= 1
        ? parsedConfidence
        : 0.5;
      const captionValue = item.caption_bbox ?? item.captionBBox;
      const labelValue = item.label ?? item.visibleLabel;
      const captionPosition = item.caption_position ?? item.captionPosition;
      const crossPageHint = item.cross_page_hint ?? item.crossPageHint;
      const bbox = parseLayoutVisionBox(item.bbox, `regions[${index}].bbox`);
      if (item.id !== undefined && (typeof item.id !== 'string' || !item.id.trim())) {
        throw new VisionProtocolError(`Vision JSON regions[${index}].id 必须为非空字符串`);
      }
      if (labelValue !== undefined && typeof labelValue !== 'string') {
        throw new VisionProtocolError(`Vision JSON regions[${index}].label 必须为字符串`);
      }
      if (item.evidence !== undefined && typeof item.evidence !== 'string') {
        throw new VisionProtocolError(`Vision JSON regions[${index}].evidence 必须为字符串`);
      }
      regions.push({
        type: enumValue(item.type, [
          'figure', 'table', 'display_formula', 'code',
        ] as const, `regions[${index}].type`),
        bbox,
        column: normalizedColumn(item.column, bbox),
        ...(captionValue === undefined ? {} : {
          captionBBox: parseNormalizedVisionBox(captionValue, `regions[${index}].caption_bbox`),
        }),
        confidence,
        ...(typeof item.id === 'string' && item.id.trim() ? { temporaryId: item.id.trim().slice(0, 100) } : {}),
        ...(typeof labelValue === 'string' && labelValue.trim() ? { visibleLabel: labelValue.trim().slice(0, 100) } : {}),
        ...(captionPosition === undefined ? {} : {
          captionPosition: enumValue(
            captionPosition,
            ['above', 'below', 'none', 'unknown'] as const,
            `regions[${index}].caption_position`,
          ),
        }),
        ...(crossPageHint === undefined ? {} : {
          crossPageHint: enumValue(
            crossPageHint,
            ['none', 'starts', 'continues', 'ends', 'unknown'] as const,
            `regions[${index}].cross_page_hint`,
          ),
        }),
        ...(typeof item.evidence === 'string' && item.evidence.trim()
          ? { evidence: item.evidence.trim().slice(0, 240) }
          : {}),
      });
  });

  return { pageIndex: expectedPageIndex, layout, regions };
}

export function serializeVisionPageAnalysis(analysis: VisionPageAnalysis): Record<string, unknown> {
  return {
    page: analysis.pageIndex + 1,
    layout: analysis.layout,
    regions: analysis.regions.map((region) => ({
      type: region.type,
      bbox: [...region.bbox],
      column: region.column,
      ...(region.captionBBox ? { caption_bbox: [...region.captionBBox] } : {}),
      confidence: region.confidence,
      ...(region.temporaryId ? { id: region.temporaryId } : {}),
      ...(region.visibleLabel ? { label: region.visibleLabel } : {}),
      ...(region.captionPosition ? { caption_position: region.captionPosition } : {}),
      ...(region.crossPageHint ? { cross_page_hint: region.crossPageHint } : {}),
      ...(region.evidence ? { evidence: region.evidence } : {}),
    })),
  };
}
