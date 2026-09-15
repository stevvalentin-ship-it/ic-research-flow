import type { Rect } from '../../types/models';
import { OPS } from './runtime';

type Matrix = [number, number, number, number, number, number];

export interface PdfOperatorListLike {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
}

function multiply(left: Matrix, right: readonly number[]): Matrix {
  return [
    left[0] * right[0]! + left[2] * right[1]!,
    left[1] * right[0]! + left[3] * right[1]!,
    left[0] * right[2]! + left[2] * right[3]!,
    left[1] * right[2]! + left[3] * right[3]!,
    left[0] * right[4]! + left[2] * right[5]! + left[4],
    left[1] * right[4]! + left[3] * right[5]! + left[5],
  ];
}

function transformedUnitSquare(matrix: Matrix): Rect {
  const points = [
    [matrix[4], matrix[5]],
    [matrix[0] + matrix[4], matrix[1] + matrix[5]],
    [matrix[2] + matrix[4], matrix[3] + matrix[5]],
    [matrix[0] + matrix[2] + matrix[4], matrix[1] + matrix[3] + matrix[5]],
  ];
  const xs = points.map(([x]) => x!);
  const ys = points.map(([, y]) => y!);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Reconstruct the exact page-space rectangles of raster image XObjects.
 * PDF.js paints every image into the current transformation's unit square;
 * applying the page viewport matrix therefore recovers the same rectangle the
 * renderer uses, without asking a vision model to estimate its edges.
 */
export function extractBitmapRegions(
  operatorList: PdfOperatorListLike,
  viewportTransform: readonly number[],
): Rect[] {
  if (viewportTransform.length !== 6) throw new Error('PDF viewport transform must contain six numbers');
  const viewport = [...viewportTransform] as Matrix;
  let current: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const regions: Rect[] = [];
  const imageOps = new Set<number>([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject,
    OPS.paintSolidColorImageMask,
  ]);

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index];
    if (fn === OPS.save) {
      stack.push([...current] as Matrix);
    } else if (fn === OPS.restore) {
      current = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    } else if (fn === OPS.transform) {
      const args = operatorList.argsArray[index];
      if (Array.isArray(args) && args.length === 6 && args.every(Number.isFinite)) {
        current = multiply(current, args as number[]);
      }
    } else if (fn !== undefined && imageOps.has(fn)) {
      const rect = transformedUnitSquare(multiply(viewport, current));
      if ([rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.w > 0.5 && rect.h > 0.5) {
        regions.push(rect);
      }
    }
  }
  return regions;
}
