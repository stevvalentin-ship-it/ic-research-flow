// ============================================================================
// paginate/index.ts —— 分页器的类型化入口(核心实现在 paginator.core.js,
// 浏览器/Node 同一份源码;此处只做类型包装,不复制逻辑)
// ============================================================================
import './paginator.core.js';

export type PaginatorMode = 'single' | 'double' | 'mixed';
export type PaginatorWidthMode = 'column' | 'span';

export interface PaginatorBlockInput {
  id: string;
  type:
    | 'title'
    | 'authors'
    | 'abstract'
    | 'keywords'
    | 'section'
    | 'paragraph'
    | 'reference'
    | 'figure'
    | 'table'
    | 'equation'
    | 'caption';
  text?: string;
  atomicH?: number;
  fontSize?: number;
  widthMode?: PaginatorWidthMode;
  frontMatter?: boolean;
  caption?: string;
  label?: string;
}

export interface PaginatorPageGeom {
  w: number;
  h: number;
  margin: number;
  gutter: number;
  usableW: number;
  colW: number;
  usableH: number;
}

export interface PaginatorLogEntry {
  id: string;
  type: PaginatorBlockInput['type'];
  page: number;
  col: 'single' | 'full' | 'left' | 'right' | 'span';
  y: number;
  h: number;
  frags: '整' | '断';
  note: string;
}

export interface PaginatorResult {
  pages: any[];
  log: PaginatorLogEntry[];
  fragments: { page: number; col: string; y: number; blockId: string }[];
  issues: { block: string; msg: string }[];
  geom: PaginatorPageGeom;
}

interface Core {
  DEFAULT_GEOM: PaginatorPageGeom;
  paginate(blocks: PaginatorBlockInput[], opts: {
    mode: PaginatorMode;
    measureText: (text: string, width: number, fontSize: number) => number;
    geom?: PaginatorPageGeom;
  }): PaginatorResult;
  validateOrder(blocks: PaginatorBlockInput[], log: PaginatorLogEntry[]): {
    ok: boolean;
    got: string[];
    expect: string[];
    contOk: boolean;
    complete: boolean;
  };
  chunkText(
    text: string,
    widthPx: number,
    maxH: number,
    fontSize: number,
    measure: (text: string, width: number, fontSize: number) => number,
  ): { text: string; h: number }[];
}

const core = (globalThis as any).PaperParallelPaginator as Core;

export const DEFAULT_GEOM = core.DEFAULT_GEOM;

export const paginate = core.paginate.bind(core) as Core['paginate'];
export const validateOrder = core.validateOrder.bind(core) as Core['validateOrder'];
export const chunkText = core.chunkText.bind(core) as Core['chunkText'];

/** DOM 测量适配器:浏览器中用隐藏元素测量真实断行高度(单例,避免频繁创建) */
let measurer: HTMLDivElement | null = null;
export function createDomMeasure() {
  return (text: string, widthPx: number, fontSize: number): number => {
    if (typeof document === 'undefined') {
      // Node 兜底:等宽近似(测试中不应走到这里)
      const lineH = fontSize * 1.6;
      const cpl = Math.max(1, Math.floor(widthPx / (fontSize * 1.05)));
      return Math.max(lineH, Math.ceil([...text].length / cpl) * lineH);
    }
    if (!measurer) {
      measurer = document.createElement('div');
      measurer.style.cssText =
        'position:absolute;left:-99999px;top:0;visibility:hidden;' +
        'font-family:Georgia,"Noto Serif SC","SimSun",serif;text-align:justify;';
      document.body.appendChild(measurer);
    }
    measurer.style.width = widthPx + 'px';
    measurer.style.fontSize = fontSize + 'px';
    measurer.style.lineHeight = '1.6';
    measurer.textContent = text;
    return measurer.getBoundingClientRect().height;
  };
}
