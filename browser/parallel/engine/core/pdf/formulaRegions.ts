import type { Rect } from '../../types/models';
import type { DetectedAssetRegion } from '../assets/extract';
import type { SimpleTextItem } from '../parser/lines';

export interface FormulaTextRun extends SimpleTextItem {
  fontName?: string;
  sourceRect?: Rect;
}

export interface FontFormulaRegion extends DetectedAssetRegion { sourceTextRects: Rect[] }

function mathFont(run: FormulaTextRun): boolean {
  return /(?:LMMath|\bCM(?:MI|SY|EX)\d|\bMS[AB]M\d|MathItalic|MathSymbol|MathExtension)/i.test(run.fontName ?? '');
}

function mathRun(run: FormulaTextRun): boolean {
  const text = run.str.trim();
  if (!text) return false;
  if (mathFont(run)) return true;
  return /^(?:log|ln|sin|cos|tan|min|max|mod)$/u.test(text)
    || (/^[\d\sA-Za-z.,()[\]{}|^ˆ′'_=+−\-*/∑∏∫√≤≥≈≠⌈⌉⌊⌋⟨⟩→←↦×λα-ωΑ-Ω]+$/u.test(text)
      && !/[A-Za-z]{2,}/u.test(text));
}

function union(runs: readonly FormulaTextRun[]): Rect {
  const x = Math.min(...runs.map((run) => run.x));
  const y = Math.min(...runs.map((run) => run.y));
  return {
    x, y,
    w: Math.max(...runs.map((run) => run.x + run.w)) - x,
    h: Math.max(...runs.map((run) => run.y + run.h)) - y,
  };
}

/** Preserve math-font runs before PDF block grouping scatters their scripts. */
export function detectFontFormulaRegions(
  input: readonly FormulaTextRun[],
  pageIndex: number,
): FontFormulaRegion[] {
  const runs = input.filter((run) => run.str.trim() && run.w > 0 && run.h > 0);
  const groups: FormulaTextRun[][] = [];
  let group: FormulaTextRun[] = [];
  const flush = () => { if (group.length) groups.push(group); group = []; };
  for (const run of runs) {
    if (!mathRun(run)) { flush(); continue; }
    if (group.length) {
      const rect = union(group);
      const gapX = Math.max(0, run.x - rect.x - rect.w, rect.x - run.x - run.w);
      const gapY = Math.max(0, run.y - rect.y - rect.h, rect.y - run.y - run.h);
      if (gapX > 24 || gapY > 12 || run.y > rect.y + 36) flush();
    }
    group.push(run);
  }
  flush();
  const merged: FormulaTextRun[][] = [];
  for (const entries of groups) {
    const previous = merged.at(-1);
    const rect = union(entries);
    const previousRect = previous ? union(previous) : undefined;
    const combined = previous ? union([...previous, ...entries]) : rect;
    const interveningProse = runs.some((run) => !mathRun(run)
      && run.x < combined.x + combined.w && run.x + run.w > combined.x
      && run.y < combined.y + combined.h && run.y + run.h > combined.y);
    // Aligned continuation rows belong to one display equation, even though
    // the PDF places their limits and equality signs in separate text runs.
    if (previous && previousRect && /^\s*=/.test(entries.map((run) => run.str).join(''))
      && previous.some((run) => run.str.includes('=')) && previousRect.h > 20
      && rect.y > previousRect.y && rect.y - previousRect.y - previousRect.h < 25
      && combined.h < 160 && !interveningProse) previous.push(...entries);
    else merged.push([...entries]);
  }
  return merged.flatMap((entries, index) => {
    const text = entries.map((run) => run.str).join('');
    const hasMathFont = entries.some(mathFont);
    const hasOperator = /[=+−∑∏∫√≤≥≈≠⌈⌉⌊⌋×]/u.test(text);
    const sizes = entries.map((run) => (run.sourceRect ?? run).h);
    const scriptedVariable = entries.length >= 2 && /[A-Za-zα-ωΑ-Ω]/u.test(text)
      && Math.min(...sizes) < Math.max(...sizes) * 0.85;
    const romanScript = scriptedVariable && /^[A-Z][0-9]+[.,]?$/.test(text);
    if ((!hasMathFont && !romanScript) || (!hasOperator && !scriptedVariable) || !/[A-Za-zα-ωΑ-Ω∑∏∫]/u.test(text)
      || text.replace(/\s/gu, '').length < (scriptedVariable ? 2 : 3)) return [];
    const rect = union(entries);
    if (rect.h > 160) return [];
    // Keep the PDF operator sequence: a nearby thin minus sign may belong to
    // the following line, so geometric proximity alone cannot attach scripts.
    const scripts: FormulaTextRun[] = [];
    const numbered = runs.find((run) => /^\(\d+\)$/.test(run.str.trim())
      && run.x > rect.x + rect.w && run.x - rect.x - rect.w < 240
      && run.y < rect.y + rect.h + 3 && run.y + run.h > rect.y - 3);
    if (numbered && text.includes('=') && !runs.some((run) => !mathRun(run)
      && run.y + run.h > rect.y + 3 && run.y < rect.y + rect.h - 3)) scripts.push(numbered);
    const complete = union([...entries, ...scripts]);
    // Ensure the crop cannot consume a word from an adjacent text run.
    if (runs.some((run) => !mathRun(run)
      && Math.min(run.x + run.w, complete.x + complete.w) - Math.max(run.x, complete.x) > 1
      && Math.min(run.y + run.h, complete.y + complete.h)
        - Math.max(run.y + (run.y === run.sourceRect?.y ? run.h * 0.3 : 0), complete.y) > 2)) return [];
    const crop = { x: Math.max(0, complete.x - 0.3), y: Math.max(0, complete.y - 0.3),
      w: complete.w + 0.6, h: complete.h + 0.6 };
    return [{
      id: `font-formula-${pageIndex + 1}-${index + 1}`, kind: 'formula' as const,
      pageIndex, rect: crop,
      widthMode: 'column' as const,
      // Retain rules and fraction bars between glyphs as well as the glyphs.
      preserveRects: [crop],
      formulaHint: text,
      requiresLargeOperator: /[∑∏∫]/u.test(text),
      sourceTextRects: [...entries, ...scripts].map((run) => run.sourceRect ?? run),
      geometrySource: 'font-runs' as const,
    }];
  });
}
