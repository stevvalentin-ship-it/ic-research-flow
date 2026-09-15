// ============================================================================
// paginator.core.js —— 块级分页器核心(浏览器 / Node 通用,零依赖)
// 算法基准:P3 探针(双栏/单栏/混合三种版式块序校验全部通过)
//
// 双环境加载方式(同一份源码,不复制):
//   浏览器:<script src="paginator.core.js"></script> -> globalThis.PaperParallelPaginator
//   Node/Vitest:await import('./paginator.core.js') -> globalThis.PaperParallelPaginator
//
// 设计:measureText 由调用方注入(浏览器用隐藏 DOM 测量,测试用确定性假测量),
// 因此核心逻辑完全纯函数。
// ============================================================================

/**
 * @typedef {Object} PaginatorBlock
 * @property {string} id
 * @property {string} type  title|authors|abstract|keywords|section|paragraph|reference|figure|table|equation|caption
 * @property {string} [text]
 * @property {number} [atomicH]  原子块(图/表/公式)的固定高度(px)
 * @property {number} [fontSize] 默认 13
 * @property {'column'|'span'} [widthMode] 默认 'column'
 * @property {boolean} [frontMatter] 标题/作者/摘要/关键词等页顶通栏内容
 * @property {string} [caption]
 * @property {string} [label]
 */

/**
 * @typedef {Object} PageGeom
 * @property {number} w @property {number} h
 * @property {number} margin @property {number} gutter
 */

/**
 * @typedef {Object} PlaceItem
 * @property {PaginatorBlock} block @property {number} y @property {number} h
 */

/**
 * @typedef {Object} PaginatorOptions
 * @property {'single'|'double'|'mixed'} mode
 * @property {(text:string,width:number,fontSize:number)=>number} measureText
 * @property {PageGeom} [geom]
 */

const DEFAULT_GEOM = (() => {
  const MM = 96 / 25.4;
  const w = 210 * MM;
  const h = 297 * MM;
  const margin = 18 * MM;
  const gutter = 6 * MM;
  return {
    w,
    h,
    margin,
    gutter,
    usableW: w - margin * 2,
    colW: (w - margin * 2 - gutter) / 2,
    usableH: h - margin * 2,
  };
})();

const TEXT_TYPES = new Set([
  'title',
  'authors',
  'abstract',
  'keywords',
  'section',
  'paragraph',
  'reference',
]);
/**
 * 按句边界切块:每片高度 <= maxH;超长句按字硬切。
 * @param {string} text
 * @param {number} widthPx
 * @param {number} maxH
 * @param {number} fontSize
 * @param {(t:string,w:number,f:number)=>number} measure
 * @returns {{text:string,h:number}[]}
 */
function chunkText(text, widthPx, maxH, fontSize, measure) {
  const full = measure(text, widthPx, fontSize);
  if (full <= maxH) return [{ text, h: full }];
  const sentences = text.match(/[^。！？.!?\n]+[。！？.!?]?|\n+/g) || [text];
  const out = [];
  let cur = '';
  for (const s of sentences) {
    const cand = cur + s;
    const h = measure(cand, widthPx, fontSize);
    if (h <= maxH || !cur) {
      cur = cand;
      continue;
    }
    if (cur) {
      out.push({ text: cur, h: measure(cur, widthPx, fontSize) });
      cur = '';
    }
    const sh = measure(s, widthPx, fontSize);
    if (sh <= maxH) {
      cur = s;
    } else {
      let acc = '';
      for (const ch of s) {
        const t2 = acc + ch;
        const h2 = measure(t2, widthPx, fontSize);
        if (h2 <= maxH) acc = t2;
        else {
          if (acc) out.push({ text: acc, h: measure(acc, widthPx, fontSize) });
          acc = ch;
        }
      }
      cur = acc;
    }
  }
  if (cur.trim()) out.push({ text: cur, h: measure(cur, widthPx, fontSize) });
  return out;
}

/**
 * 块级分页器(块 -> 栏 -> 页)。规则与 P3 探针完全一致:
 * - 版式继承:single / double / mixed(首页通栏 frontMatter + 正文双栏)
 * - 页数自然延伸,不对齐原分页
 * - 文字块按句边界跨栏断块;图/表/公式/题注整块不可劈开
 * - 严格保序:原子块跳右栏顶时关闭左栏余量;跨栏块放新页页顶
 * @param {PaginatorBlock[]} blocks
 * @param {PaginatorOptions} opts
 */
function paginate(blocks, opts) {
  const geom = opts.geom || DEFAULT_GEOM;
  const { margin, gutter, usableW, colW, usableH } = geom;
  const measure = opts.measureText;
  const mode = opts.mode;

  const pages = [];
  const log = [];
  const fragments = [];
  const issues = [];

  const newPage = (m) => ({
    mode: m,
    single: { cursor: margin, blocks: [] },
    full: { cursor: margin, blocks: [] },
    left: { cursor: margin, blocks: [] },
    right: { cursor: margin, blocks: [] },
    spans: [],
  });
  const firstPageMode = () => (mode === 'single' ? 'single' : mode === 'double' ? 'double' : 'mixed');
  const nextPageMode = () => (mode === 'single' ? 'single' : 'double');

  const columnSlots = (page) => {
    if (page.mode === 'single') {
      return [{ col: 'single', x: margin, w: usableW, getH: () => usableH - (page.single.cursor - margin) }];
    }
    return [
      { col: 'left', x: margin, w: colW, getH: () => usableH - (page.left.cursor - margin) },
      { col: 'right', x: margin + colW + gutter, w: colW, getH: () => usableH - (page.right.cursor - margin) },
    ];
  };

  const pushCol = (page, col, blk, y, h) => {
    page[col].blocks.push({ block: blk, y, h });
    page[col].cursor = y + h;
  };
  const pushSpan = (page, blk, y, h) => {
    page.spans.push({ block: blk, y, h });
    page.left.cursor = Math.max(page.left.cursor, y + h);
    page.right.cursor = Math.max(page.right.cursor, y + h);
    page.full.cursor = Math.max(page.full.cursor, y + h);
    if (page.mode === 'single') page.single.cursor = Math.max(page.single.cursor, y + h);
  };

  const placeText = (page, colName, w, blk, text, remH, fontSize) => {
    const chunks = chunkText(text, w, remH, fontSize, measure);
    const piece = chunks[0];
    const y = page[colName].cursor;
    pushCol(page, colName, { ...blk, text: piece.text }, y, piece.h);
    fragments.push({ page: pages.length - 1, col: colName, y, blockId: blk.id });
    log.push({
      ...blk,
      page: pages.length - 1,
      col: colName,
      y,
      h: piece.h,
      frags: chunks.length > 1 ? '断' : '整',
      note: chunks.length > 1 ? '跨栏断块' : '',
    });
    return chunks.slice(1).map((c) => c.text).join('');
  };

  const placeSpan = (page, blk, h) => {
    if (h > usableH) {
      issues.push({
        block: blk.id,
        msg: `原子块高度 ${h.toFixed(0)}px 超过页高 ${usableH.toFixed(0)}px,缩放 ${(usableH / h).toFixed(2)} 并标记人工审核`,
      });
      log.push({ ...blk, page: pages.length - 1, col: 'span', y: margin, h: usableH, frags: '整', note: '⚠ 超高块已缩放' });
      pushSpan(page, blk, margin, usableH);
      return;
    }
    pushSpan(page, blk, margin, h);
    log.push({ ...blk, page: pages.length - 1, col: 'span', y: margin, h, frags: '整', note: '跨栏通栏块' });
  };

  for (const blk of blocks) {
    const fontSize = blk.fontSize || 13;
    const lineH = fontSize * 1.6 + 2;

    if (!TEXT_TYPES.has(blk.type)) {
      // ---- 原子块 ----
      const h = blk.atomicH || 0;
      let placed = false;
      const page = pages.length ? pages[pages.length - 1] : null;

      if (page && blk.widthMode === 'column') {
        for (const slot of columnSlots(page)) {
          if (h <= slot.getH() + 0.5) {
            let note = '';
            if (page.mode !== 'single' && slot.col === 'right') {
              const leftRem = usableH - (page.left.cursor - margin);
              if (leftRem > 0.5) {
                page.left.cursor = margin + usableH; // 关闭左栏余量以保序
                note = '左栏余量关闭以保序';
              }
            }
            const y = page[slot.col].cursor;
            pushCol(page, slot.col, blk, y, h);
            log.push({ ...blk, page: pages.length - 1, col: slot.col, y, h, frags: '整', note });
            placed = true;
            break;
          }
        }
      }
      if (!placed && page && blk.widthMode === 'span') {
        const empty =
          page.left.cursor === margin &&
          page.right.cursor === margin &&
          page.spans.length === 0 &&
          page.single.cursor === margin &&
          page.full.cursor === margin;
        if (empty) {
          placeSpan(page, blk, h);
          placed = true;
        }
      }
      if (!placed) {
        const p = newPage(nextPageMode());
        pages.push(p);
        if (blk.widthMode === 'span') {
          placeSpan(p, blk, h);
        } else {
          const col = p.mode === 'single' ? 'single' : 'left';
          pushCol(p, col, blk, margin, h);
          log.push({ ...blk, page: pages.length - 1, col, y: margin, h, frags: '整', note: '新页' });
        }
      }
      continue;
    }

    // ---- 文字流块 ----
    let remaining = blk.text || '';
    let safety = 0;
    while (remaining.trim() && safety++ < 500) {
      let page = pages.length ? pages[pages.length - 1] : null;
      if (!page) {
        page = newPage(firstPageMode());
        pages.push(page);
      }
      let slot = null;

      if (blk.frontMatter && page.mode !== 'single') {
        let remH = usableH - (page.full.cursor - margin);
        if (remH <= lineH) {
          const p = newPage(page.mode);
          pages.push(p);
          page = p;
          remH = usableH;
        }
        slot = { col: 'full', w: usableW, remH: usableH - (page.full.cursor - margin) };
      } else {
        if (
          page.mode !== 'single' &&
          page.full.cursor > margin &&
          page.left.cursor === margin &&
          page.right.cursor === margin
        ) {
          page.left.cursor = page.right.cursor = page.full.cursor;
        }
        for (const s of columnSlots(page)) {
          const h = s.getH();
          if (h > lineH) {
            slot = { ...s, remH: h };
            break;
          }
        }
      }
      if (!slot) {
        const p = newPage(nextPageMode());
        pages.push(p);
        page = p;
        slot = {
          col: p.mode === 'single' ? 'single' : 'left',
          w: p.mode === 'single' ? usableW : colW,
          remH: usableH,
        };
      }
      remaining = placeText(page, slot.col, slot.w, blk, remaining, slot.remH, fontSize);
    }
  }

  return { pages, log, fragments, issues, geom };
}

/**
 * 顺序校验:压缩片段后,块顺序必须等于原始块顺序,且每个块的片段连续出现。
 * @param {PaginatorBlock[]} blocks
 * @param {Array<any>} log
 */
function validateOrder(blocks, log) {
  const colRank = (l) => (l.col === 'full' || l.col === 'span' || l.col === 'single' ? 0 : l.col === 'left' ? 1 : 2);
  const seq = [...log].sort((a, b) => a.page - b.page || colRank(a) - colRank(b) || a.y - b.y);
  const idAt = new Map(blocks.map((b, i) => [b.id, i]));
  const ranges = new Map();
  seq.forEach((f, i) => {
    if (!ranges.has(f.id)) ranges.set(f.id, { min: i, max: i });
    else {
      const r = ranges.get(f.id);
      r.min = Math.min(r.min, i);
      r.max = Math.max(r.max, i);
    }
  });
  const sorted = [...ranges.entries()].sort((a, b) => a[1].min - b[1].min);
  let orderOk = true;
  sorted.forEach(([id], i) => {
    if (idAt.get(id) !== i) orderOk = false;
  });
  let contOk = true;
  for (const [id, r] of sorted) {
    for (const [oid, or] of ranges) {
      if (oid !== id && or.min < r.max && or.max > r.min) contOk = false;
    }
  }
  const complete = blocks.every((b) => ranges.has(b.id));
  return { ok: orderOk && contOk && complete, got: sorted.map((s) => s[0]), expect: blocks.map((b) => b.id), contOk, complete };
}

// 双环境暴露:浏览器全局 / Node(import 副作用后从 globalThis 读取)
const __rootPaginator = typeof globalThis !== 'undefined' ? globalThis : this;
__rootPaginator.PaperParallelPaginator = { DEFAULT_GEOM, chunkText, paginate, validateOrder };
