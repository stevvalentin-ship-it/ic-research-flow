import { OPS } from './runtime';
import { normalizeTextItem, type PdfTextItemLike, type PdfViewportLike } from '../parser/pdfjsAdapter';
import type { FormulaTextRun } from './formulaRegions';

interface PdfGlyph { unicode: string; fontChar: string; width: number }
interface PdfFont { name?: string; loadedName: string }

/** Measure the embedded glyph, including large operators drawn below the baseline. */
export function measureFormulaTextRuns(
  items: readonly (PdfTextItemLike & { fontName: string })[],
  viewport: PdfViewportLike,
  operators: { fnArray: number[]; argsArray: any[] },
  resolveFont: (id: string) => PdfFont | undefined,
): FormulaTextRun[] {
  const byFont = new Map<string, Map<string, PdfGlyph[]>>();
  let fontId = '';
  operators.fnArray.forEach((operator, index) => {
    if (operator === OPS.setFont) fontId = operators.argsArray[index][0];
    if (operator !== OPS.showText) return;
    const glyphs = byFont.get(fontId) ?? new Map<string, PdfGlyph[]>();
    for (const glyph of operators.argsArray[index][0] as Array<PdfGlyph | number>) {
      if (typeof glyph !== 'object' || !glyph.unicode) continue;
      const variants = glyphs.get(glyph.unicode) ?? [];
      if (!variants.some((entry) => entry.fontChar === glyph.fontChar)) variants.push(glyph);
      glyphs.set(glyph.unicode, variants);
    }
    byFont.set(fontId, glyphs);
  });
  const context = document.createElement('canvas').getContext('2d');
  return items.map((item) => {
    const sourceRect = normalizeTextItem(item, viewport);
    let font: PdfFont | undefined;
    try { font = resolveFont(item.fontName); } catch { /* Optional embedded font evidence. */ }
    const fallback = { ...sourceRect, fontName: font?.name, sourceRect };
    if (!context || !font || sourceRect.geometry) return fallback;
    const mapping = byFont.get(item.fontName);
    const glyphs = [...item.str].map((character) => {
      const variants = mapping?.get(character);
      if (!variants?.length) return undefined;
      return item.str.length === 1
        ? [...variants].sort((left, right) => Math.abs(left.width * sourceRect.h / 1000 - sourceRect.w)
          - Math.abs(right.width * sourceRect.h / 1000 - sourceRect.w))[0]
        : variants[0];
    });
    if (glyphs.some((glyph) => !glyph)) return fallback;
    context.font = `100px "${font.loadedName}"`;
    const measured = context.measureText(glyphs.map((glyph) => glyph!.fontChar).join(''));
    const ascent = measured.actualBoundingBoxAscent * sourceRect.h / 100;
    const descent = measured.actualBoundingBoxDescent * sourceRect.h / 100;
    if (!Number.isFinite(ascent + descent) || ascent + descent <= 0) return fallback;
    return { ...fallback, y: sourceRect.y + sourceRect.h - ascent, h: ascent + descent };
  });
}
