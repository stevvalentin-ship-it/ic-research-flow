import type { Rect } from '../../types/models';

/** Oriented em box, preserving the PDF text run's baseline and source order. */
export interface TextRunGeometry {
  x: number;
  y: number;
  advanceX: number;
  advanceY: number;
  ascentX: number;
  ascentY: number;
}

export function textRunRect(run: TextRunGeometry, start = 0, end = 1): Rect {
  const x1 = run.x + run.advanceX * start;
  const x2 = run.x + run.advanceX * end;
  const y1 = run.y + run.advanceY * start;
  const y2 = run.y + run.advanceY * end;
  return {
    x: Math.min(x1, x2) + Math.min(0, run.ascentX),
    y: Math.min(y1, y2) + Math.min(0, run.ascentY),
    w: Math.abs(x2 - x1) + Math.abs(run.ascentX),
    h: Math.abs(y2 - y1) + Math.abs(run.ascentY),
  };
}
