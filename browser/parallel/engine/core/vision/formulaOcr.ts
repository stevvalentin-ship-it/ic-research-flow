import { chatCompletion } from '../translate/client';
import { REQUIRED_VISION_MODEL_ID } from './model';

export const FORMULA_OCR_MODEL = REQUIRED_VISION_MODEL_ID;
export const FORMULA_OCR_PROMPT_VERSION = 'formula-ocr-v1';

export interface FormulaOcrResult {
  latex: string;
  confidence: number;
}

function parseJson(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    return JSON.parse(fenced ? fenced[1]! : trimmed);
  } catch {
    throw new Error('公式视觉转写返回了无效 JSON');
  }
}

export function parseFormulaOcrResult(input: unknown): FormulaOcrResult {
  const value = parseJson(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('公式视觉转写结果必须为对象');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.latex !== 'string') throw new Error('公式视觉转写缺少 LaTeX');
  const latex = record.latex.trim().replace(/^\$+|\$+$/g, '').trim();
  if (latex.length < 3 || latex.length > 1_200 || /\\(?:documentclass|begin\s*\{document\}|input|include|write|html)/i.test(latex)) {
    throw new Error('公式视觉转写 LaTeX 不安全或长度异常');
  }
  const rawConfidence = typeof record.confidence === 'number'
    ? record.confidence
    : Number(record.confidence);
  const confidence = rawConfidence > 1 && rawConfidence <= 100
    ? rawConfidence / 100
    : rawConfidence;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('公式视觉转写置信度无效');
  }
  return { latex, confidence };
}

export function parseCachedFormulaOcrResult(input: string): FormulaOcrResult | undefined {
  try {
    return parseFormulaOcrResult(JSON.parse(input));
  } catch {
    return undefined;
  }
}

async function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('公式截图编码失败'));
    reader.readAsDataURL(blob);
  });
}

export async function recognizeFormulaCrop(options: {
  blob: Blob;
  baseUrl: string;
  apiKey: string;
  formulaHint?: string;
  requiresLargeOperator?: boolean;
  signal?: AbortSignal;
}): Promise<FormulaOcrResult> {
  const hint = options.formulaHint?.replace(/\s+/g, ' ').trim().slice(0, 240);
  const imageUrl = await blobDataUrl(options.blob);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const completion = await chatCompletion({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: FORMULA_OCR_MODEL,
        thinkingMode: 'disabled',
        responseFormat: 'json_object',
        temperature: 0,
        maxTokens: 700,
        timeoutMs: 90_000,
        signal: options.signal,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                'Transcribe the one intended mathematical formula in this enlarged academic-paper crop into exact LaTeX.',
                'The crop can contain parts of English lines above or below the formula; ignore every prose fragment.',
                'Preserve every vector/bold style, hat, prime, index, lower/upper limit, subscript, superscript, bracket, and operator exactly as visibly printed.',
                'Never rewrite the formula into an equivalent form and never invent a symbol hidden by prose.',
                hint ? `The PDF text-layer hint for identifying the intended formula is: ${hint}` : '',
                options.requiresLargeOperator ? 'The intended formula visibly contains a summation, product, or integral; it must appear in LaTeX.' : '',
                attempt > 0 ? 'The previous response violated the required protocol. Return one valid JSON object and no Markdown or prose.' : '',
                'Return JSON only: {"latex":"exact LaTeX without delimiters","confidence":0.0}.',
              ].filter(Boolean).join('\n'),
            },
            { type: 'image_url', image_url: { url: imageUrl, detail: 'original' } },
          ],
        }],
      });
      const result = parseFormulaOcrResult(completion.content);
      if (result.confidence < 0.82) throw new Error('公式视觉转写置信度不足');
      // In JavaScript regular expressions `_` is a word character, so `\b` does
      // not match the normal TeX spelling `\sum_{...}`. Match the command itself
      // and let the TeX parser validate what follows.
      if (options.requiresLargeOperator && !/\\(?:sum|prod|int)/.test(result.latex)) {
        throw new Error('公式视觉转写遗漏大运算符');
      }
      if (hint?.includes('=') && !result.latex.includes('=')) {
        throw new Error('公式视觉转写遗漏等号');
      }
      return result;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('公式视觉转写失败');
}
