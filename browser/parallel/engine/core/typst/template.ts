export type TargetLayoutPolicy = 'source-layout' | 'single-column';

export interface AcademicTemplateOptions {
  paperWidth: number;
  paperHeight: number;
  margin?: number;
  columnGap?: number;
  targetLayoutPolicy?: TargetLayoutPolicy;
}

/**
 * Deterministic typography tokens for the Chinese single-column target.
 * DeepSeek may translate and review the result, but it must not silently
 * override these values.
 */
export const SINGLE_COLUMN_TYPOGRAPHY = {
  textSizePt: 10.5,
  leadingEm: 1,
  paragraphSpacingEm: 0.42,
  firstLineIndentEm: 2,
  majorHeading: { sizePt: 13, abovePt: 14, belowPt: 8 },
  minorHeading: { sizePt: 11.5, abovePt: 10, belowPt: 7 },
} as const;

function points(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new Error('Paper dimensions must be positive');
  return `${value}pt`;
}

export function buildAcademicTemplate(options: AcademicTemplateOptions): string {
  const margin = options.margin ?? Math.max(36, options.paperWidth * 0.1);
  const gutter = options.columnGap ?? 12;
  const singleColumn = options.targetLayoutPolicy === 'single-column';
  const textSize = singleColumn ? SINGLE_COLUMN_TYPOGRAPHY.textSizePt : 10;
  const leading = singleColumn ? SINGLE_COLUMN_TYPOGRAPHY.leadingEm : 0.65;
  const paragraphSpacing = singleColumn
    ? `${SINGLE_COLUMN_TYPOGRAPHY.paragraphSpacingEm}em`
    : '0pt';
  const firstLineIndent = singleColumn
    ? `(amount: ${SINGLE_COLUMN_TYPOGRAPHY.firstLineIndentEm}em, all: true)`
    : '0pt';
  const majorHeading = singleColumn
    ? SINGLE_COLUMN_TYPOGRAPHY.majorHeading
    : { sizePt: 12, abovePt: 7, belowPt: 3 };
  const minorHeading = singleColumn
    ? SINGLE_COLUMN_TYPOGRAPHY.minorHeading
    : majorHeading;
  const doubleLayout = singleColumn
    ? '#let pp-double(body) = body'
    : `#let pp-double(body) = columns(2, gutter: ${points(gutter)})[#body]`;
  return `#set page(
  width: ${points(options.paperWidth)},
  height: ${points(options.paperHeight)},
  margin: ${points(margin)},
  footer: context [#counter(page).display()],
)
#set text(font: ("Noto Serif SC", "DejaVu Math TeX Gyre", "DejaVu Serif"), size: ${textSize}pt)
#set par(
  justify: true,
  leading: ${leading}em,
  spacing: ${paragraphSpacing},
  first-line-indent: ${firstLineIndent},
)
#set heading(numbering: "1.1")

#let pp-full-width(body) = body
${doubleLayout}
#let pp-single(body) = body
#let pp-unit(id, body) = link("https://paper-parallel.invalid/unit/" + id)[#body]
#let pp-inline-asset(id, path, source-width) = box(baseline: 20%)[#pp-unit(id)[#image(path, width: source-width)]]
#let pp-title(body) = {
  set par(first-line-indent: 0pt, leading: 0.35em)
  block(width: 100%, above: 4pt, below: 10pt)[#align(center)[#text(size: 17pt, weight: "bold")[#body]]]
}
#let pp-author(body) = {
  set par(first-line-indent: 0pt, leading: 0.45em)
  block(width: 100%, below: 3pt)[#align(center)[#text(size: 10pt)[#body]]]
}
#let pp-front-matter(label, body) = {
  set par(first-line-indent: 0pt, leading: 0.7em)
  block(width: 100%, above: 4pt, below: 6pt)[#text(size: 9.5pt)[#text(weight: "bold")[#label] #body]]
}
#let pp-heading(body, extra-below: 0pt) = {
  set par(first-line-indent: 0pt, leading: 0.35em)
  block(width: 100%, sticky: true, above: ${majorHeading.abovePt}pt, below: ${majorHeading.belowPt}pt + extra-below)[#text(size: ${majorHeading.sizePt}pt, weight: "bold")[#body]]
}
#let pp-subheading(body, extra-below: 0pt) = {
  set par(first-line-indent: 0pt, leading: 0.35em)
  block(width: 100%, sticky: true, above: ${minorHeading.abovePt}pt, below: ${minorHeading.belowPt}pt + extra-below)[#text(size: ${minorHeading.sizePt}pt, weight: "bold")[#body]]
}
#let pp-caption(body) = {
  set par(first-line-indent: 0pt, leading: 0.4em)
  block(width: 100%, above: 4pt, below: 8pt)[#align(center)[#text(size: 9pt)[#body]]]
}
#let pp-reference(body) = {
  set text(size: 8.5pt)
  set par(leading: 0.4em, spacing: 1.5pt, first-line-indent: 0pt, hanging-indent: 1.4em)
  body
}
#let pp-asset-group(body, column-flow: false) = {
  // Typst's multi-page columns can place an image's ink a few points beyond
  // the logical block extent at a page boundary. This small column-only strut
  // makes the native unbreakable block advance before that ambiguous edge.
  if column-flow { block(height: 8pt)[] }
  block(breakable: false, width: 100%, above: 2pt, below: 4pt)[#body]
}
#let pp-asset(id, path, source-width, span: false) = {
  let body = block(breakable: false, width: 100%)[#align(center)[#pp-unit(id)[#image(path, width: source-width)]]]
  if span { pp-full-width(body) } else { body }
}
`;
}
