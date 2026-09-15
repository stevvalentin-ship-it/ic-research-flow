// ============================================================================
// reader.core.js —— 对照阅读器核心(浏览器 / Node 通用,零依赖)
// 对应实施计划 Sprint 5:
//   - 锚点反查同步(绝不按百分比):视口位置 -> 块 -> 对齐单元 -> 对方块
//   - 同步锁:同一方向滚动只发一次命令,锁定期内忽略循环回弹
//   - 词级联动:按文本子串定位字符区间(span 校验已由 align 层完成)
// ============================================================================

/**
 * 把带 pageIndex+rect 的块展开为绝对 Y 位置索引。
 * @param {Array<{id:string,pageIndex:number,rect:{y:number,h:number}}>} blocks
 * @param {number} pageH 每页高度(视口 px)
 * @returns {{byId:Map, sorted:Array<{id,absTop,absBottom,pageIndex,rect}>}}
 */
function buildPositionIndex(blocks, pageH) {
  const sorted = blocks.map((b) => ({
    id: b.id,
    absTop: b.pageIndex * pageH + b.rect.y,
    absBottom: b.pageIndex * pageH + b.rect.y + b.rect.h,
    pageIndex: b.pageIndex,
    rect: b.rect,
  }));
  sorted.sort((a, b) => a.absTop - b.absTop);
  const byId = new Map(sorted.map((x) => [x.id, x]));
  return { sorted, byId };
}

/**
 * 把 getBoundingClientRect() 的页面/视口测量值转换为滚动内容区局部索引。
 * @param {Array<{id:string,top:number,height:number}>} measurements
 * @param {number} containerTop 内容区在同一坐标系中的 top
 */
function buildMeasuredPositionIndex(measurements, containerTop) {
  const origin = Number(containerTop) || 0;
  return buildPositionIndex(
    (Array.isArray(measurements) ? measurements : []).map((item) => ({
      id: item.id,
      pageIndex: 0,
      rect: { y: (Number(item.top) || 0) - origin, h: Math.max(1, Number(item.height) || 0) },
    })),
    0,
  );
}

/** 只有目标位置发生可见变化时，程序化滚动才会产生需要抑制的回声事件。 */
function shouldSuppressScrollEcho(currentScrollTop, targetScrollTop, epsilon = 0.5) {
  return Math.abs((Number(currentScrollTop) || 0) - (Number(targetScrollTop) || 0)) > epsilon;
}

/** 把目标滚动值钳制到浏览器实际可到达的范围。 */
function clampScrollTop(targetScrollTop, scrollHeight, clientHeight) {
  const maxScrollTop = Math.max(0, (Number(scrollHeight) || 0) - (Number(clientHeight) || 0));
  return Math.min(maxScrollTop, Math.max(0, Number(targetScrollTop) || 0));
}

/**
 * 把对齐清单中的 PDF 矩形展开为独立页高/缩放下的绝对语义锚点。
 * @param {Array<{id:string,source?:Array,target?:Array}>} units
 * @param {'en'|'zh'} side
 * @param {number[]} pageOffsets
 * @param {number|number[]} pageScales
 */
function buildPdfPositionIndex(units, side, pageOffsets, pageScales) {
  const geometryKey = side === 'en' ? 'source' : 'target';
  const scaleFor = (page) => Array.isArray(pageScales)
    ? (Number(pageScales[page]) || 1)
    : (Number(pageScales) || 1);
  const sorted = [];
  for (const unit of Array.isArray(units) ? units : []) {
    const fragments = [];
    for (const set of Array.isArray(unit?.[geometryKey]) ? unit[geometryKey] : []) {
      const pageIndex = Number(set?.page);
      if (!Number.isFinite(pageIndex) || pageIndex < 0) continue;
      const scale = scaleFor(pageIndex);
      const pageTop = Number(pageOffsets?.[pageIndex]) || 0;
      for (const rect of Array.isArray(set?.rects) ? set.rects : []) {
        const top = pageTop + (Number(rect?.y) || 0) * scale;
        const height = Math.max(0, (Number(rect?.h) || 0) * scale);
        fragments.push({
          pageIndex,
          absTop: top,
          absBottom: top + height,
          rect,
        });
      }
    }
    fragments.sort((a, b) => a.pageIndex - b.pageIndex || a.absTop - b.absTop);
    if (!fragments.length) continue;
    const first = fragments[0];
    sorted.push({
      id: String(unit.id),
      anchor: first.absTop + (first.absBottom - first.absTop) / 2,
      pageIndex: first.pageIndex,
      fragments,
    });
  }
  sorted.sort((a, b) => a.anchor - b.anchor || a.id.localeCompare(b.id));
  return { sorted, byId: new Map(sorted.map((entry) => [entry.id, entry])) };
}

function mappedUnitId(id, unitMap) {
  if (unitMap instanceof Map) return unitMap.get(id) || id;
  if (unitMap && typeof unitMap === 'object') return unitMap[id] || id;
  return id;
}

/**
 * 以前后语义锚点插值的方式同步独立分页的两份 PDF。
 */
function resolvePdfSyncCommand(input) {
  const source = input?.sourceIndex?.sorted || [];
  const targetIndex = input?.targetIndex;
  if (!source.length || !targetIndex?.byId) return null;
  const center = Number(input.viewportCenter) || 0;
  const mapped = source
    .map((entry) => ({
      source: entry,
      target: targetIndex.byId.get(mappedUnitId(entry.id, input.unitMap)),
    }))
    .filter((pair) => pair.target);
  if (!mapped.length) return null;

  let previous = null;
  let next = null;
  for (const pair of mapped) {
    if (pair.source.anchor <= center) previous = pair;
    if (!next && pair.source.anchor >= center) next = pair;
  }
  previous ||= mapped[0];
  next ||= mapped[mapped.length - 1];

  let targetAnchor;
  if (previous !== next && next.source.anchor > previous.source.anchor) {
    const ratio = Math.min(1, Math.max(0,
      (center - previous.source.anchor) / (next.source.anchor - previous.source.anchor),
    ));
    targetAnchor = previous.target.anchor + ratio * (next.target.anchor - previous.target.anchor);
  } else {
    targetAnchor = previous.target.anchor;
  }

  const chosen = Math.abs(center - previous.source.anchor) <= Math.abs(next.source.anchor - center)
    ? previous
    : next;
  const viewportHeight = Math.max(0, Number(input.targetViewportHeight) || 0);
  const rawScrollTop = targetAnchor - viewportHeight / 2;
  const targetScrollTop = Number.isFinite(input.targetScrollHeight)
    ? clampScrollTop(rawScrollTop, input.targetScrollHeight, viewportHeight)
    : Math.max(0, rawScrollTop);
  return {
    side: input.side,
    targetSide: input.side === 'en' ? 'zh' : 'en',
    unitId: chosen.source.id,
    targetUnitId: chosen.target.id,
    targetPage: chosen.target.pageIndex,
    targetAnchor,
    targetScrollTop,
  };
}

/**
 * 定位某侧视口中心所在的块:二分最近块。
 * @param {{sorted:Array,byId:Map}} idx
 * @param {number} scrollTop
 * @param {number} viewportH
 */
function locateBlockAtViewport(idx, scrollTop, viewportH) {
  const center = scrollTop + viewportH / 2;
  let lo = 0;
  let hi = idx.sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (idx.sorted[mid].absTop <= center) lo = mid;
    else hi = mid - 1;
  }
  if (!idx.sorted.length) return null;
  return idx.sorted[Math.max(0, lo)];
}

/**
 * 对齐表:units = [{enBlockIds:[], zhBlockIds:[]}]
 * 建 blockId -> unitIndex 索引。
 * @param {Array<{enBlockIds:string[],zhBlockIds:string[]}>} units
 */
function buildUnitIndex(units) {
  const map = new Map();
  units.forEach((u, i) => {
    for (const id of u.enBlockIds || []) map.set('en:' + id, i);
    for (const id of u.zhBlockIds || []) map.set('zh:' + id, i);
  });
  return map;
}

/**
 * 锚点反查 + 计算对方滚动目标。
 * @param {Object} enIdx @param {Object} zhIdx
 * @param {Array} units @param {Map} unitIndex
 * @param {'en'|'zh'} side
 * @param {number} scrollTop
 * @param {number} viewportH
 * @returns {{side, unitIndex:number, blockId:string, targetSide:'en'|'zh', targetBlockIds:string[], targetScrollTop:number}|null}
 */
function resolveSyncCommand(enIdx, zhIdx, units, unitIndex, side, scrollTop, viewportH) {
  const idx = side === 'en' ? enIdx : zhIdx;
  const block = locateBlockAtViewport(idx, scrollTop, viewportH);
  if (!block) return null;
  const ui = unitIndex.get(side + ':' + block.id);
  if (ui === undefined || !units[ui]) return null;
  const unit = units[ui];
  const targetSide = side === 'en' ? 'zh' : 'en';
  const targetBlockIds = unit[targetSide === 'en' ? 'enBlockIds' : 'zhBlockIds'];
  if (!targetBlockIds || !targetBlockIds.length) return null;
  const targetIdx = targetSide === 'en' ? enIdx : zhIdx;
  const targets = targetBlockIds.map((id) => targetIdx.byId.get(id)).filter(Boolean);
  if (!targets.length) return null;
  const first = targets[0];
  const targetCenter = first.absTop + first.rect.h / 2;
  const targetScrollTop = Math.max(0, targetCenter - viewportH / 2);
  return { side, unitIndex: ui, blockId: block.id, targetSide, targetBlockIds, targetScrollTop, targetBlockTop: first.absTop };
}

/**
 * 同步锁:同侧滚动在 lockMs 内只允许一次命令;对侧始终允许。
 */
function createSyncController(lockMs = 150) {
  let lockedSide = null;
  let lockUntil = 0;
  return {
    /** @returns {boolean} 是否应执行同步命令 */
    shouldSync(side, now) {
      if (lockedSide === side && now < lockUntil) return false;
      lockedSide = side;
      lockUntil = now + lockMs;
      return true;
    },
    reset() {
      lockedSide = null;
      lockUntil = 0;
    },
  };
}

/**
 * 词级联动:在目标块文本中定位子串的字符区间。
 * @param {string} fullText
 * @param {string} sub
 * @returns {{start:number,end:number}|null}
 */
function locateSubstringRange(fullText, sub) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s\u3000]+/g, ' ').trim();
  const ft = norm(fullText);
  const st = norm(sub);
  if (!st) return null;
  // 归一化后索引可能与原文错位:先试原文精确,再退回归一化文本近似区间
  const direct = String(fullText || '').indexOf(sub);
  if (direct >= 0) return { start: direct, end: direct + sub.length };
  const idx = ft.indexOf(st);
  if (idx < 0) return null;
  return { start: idx, end: idx + st.length };
}

/**
 * 把项目包中的原始块整理成适合阅读器展示的纵向流。
 * 原始 PDF 坐标保存在 sourcePageIndex/sourceRect 中；阅读器使用估算高度生成
 * 稳定的虚拟坐标，避免翻译后文字变长时互相覆盖。
 * @param {Array<Object>} blocks
 * @param {{gap?:number,charsPerLine?:number,lineHeight?:number,minHeight?:number}} [opts]
 */
function buildFlowBlocks(blocks, opts = {}) {
  const gap = opts.gap ?? 12;
  const charsPerLine = opts.charsPerLine ?? 72;
  const lineHeight = opts.lineHeight ?? 24;
  const minHeight = opts.minHeight ?? 64;
  let y = 16;
  return [...(Array.isArray(blocks) ? blocks : [])]
    .sort((a, b) => {
      const ao = Number.isFinite(a?.order) ? a.order : Number.MAX_SAFE_INTEGER;
      const bo = Number.isFinite(b?.order) ? b.order : Number.MAX_SAFE_INTEGER;
      return ao - bo || (Number(a?.pageIndex) || 0) - (Number(b?.pageIndex) || 0) || String(a?.id || '').localeCompare(String(b?.id || ''));
    })
    .map((block) => {
      const type = String(block?.type || 'paragraph');
      const text = String(block?.text || block?.caption || `[${type}]`).trim() || `[${type}]`;
      const lines = Math.max(1, Math.ceil([...text].length / charsPerLine));
      const h = Math.max(minHeight, lines * lineHeight + 32);
      const flow = {
        ...block,
        id: String(block?.id || ''),
        type,
        text,
        pageIndex: 0,
        sourcePageIndex: Number.isFinite(block?.pageIndex) ? block.pageIndex : null,
        sourceRect: block?.rect || null,
        rect: { x: 0, y, w: 1, h },
      };
      y += h + gap;
      return flow;
    })
    .filter((block) => block.id);
}

/**
 * 将 P19 项目包转换为阅读器模型。无效的对齐引用会被移除，未匹配块仍保留展示。
 * @param {{enDoc?:{blocks?:Array},zhDoc?:{blocks?:Array},units?:Array,spans?:Array}} pkg
 */
function buildReaderModel(pkg) {
  const enBlocks = buildFlowBlocks(pkg?.enDoc?.blocks || []);
  const zhBlocks = buildFlowBlocks(pkg?.zhDoc?.blocks || []);
  const enIds = new Set(enBlocks.map((block) => block.id));
  const zhIds = new Set(zhBlocks.map((block) => block.id));
  const units = (Array.isArray(pkg?.units) ? pkg.units : [])
    .map((unit) => ({
      enBlockIds: (Array.isArray(unit?.enBlockIds) ? unit.enBlockIds : []).filter((id) => enIds.has(id)),
      zhBlockIds: (Array.isArray(unit?.zhBlockIds) ? unit.zhBlockIds : []).filter((id) => zhIds.has(id)),
    }))
    .filter((unit) => unit.enBlockIds.length && unit.zhBlockIds.length);
  const matchedEn = new Set(units.flatMap((unit) => unit.enBlockIds));
  const matchedZh = new Set(units.flatMap((unit) => unit.zhBlockIds));
  const enUnitIndex = new Map();
  const zhUnitIndex = new Map();
  units.forEach((unit, unitIndex) => {
    unit.enBlockIds.forEach((id) => enUnitIndex.set(id, unitIndex));
    unit.zhBlockIds.forEach((id) => zhUnitIndex.set(id, unitIndex));
  });
  enBlocks.forEach((block) => {
    block.matched = matchedEn.has(block.id);
    block.unitIndex = enUnitIndex.get(block.id) ?? null;
  });
  zhBlocks.forEach((block) => {
    block.matched = matchedZh.has(block.id);
    block.unitIndex = zhUnitIndex.get(block.id) ?? null;
  });
  const spans = (Array.isArray(pkg?.spans) ? pkg.spans : []).filter(
    (span) => enIds.has(span?.enBlockId) && zhIds.has(span?.zhBlockId),
  );
  return {
    enBlocks,
    zhBlocks,
    units,
    spans,
    contentHeight: {
      en: enBlocks.length ? enBlocks[enBlocks.length - 1].rect.y + enBlocks[enBlocks.length - 1].rect.h + 16 : 0,
      zh: zhBlocks.length ? zhBlocks[zhBlocks.length - 1].rect.y + zhBlocks[zhBlocks.length - 1].rect.h + 16 : 0,
    },
    stats: {
      enBlocks: enBlocks.length,
      zhBlocks: zhBlocks.length,
      matchedUnits: units.length,
      unmatchedEn: enBlocks.length - matchedEn.size,
      unmatchedZh: zhBlocks.length - matchedZh.size,
    },
  };
}

const __rootReader = typeof globalThis !== 'undefined' ? globalThis : this;
__rootReader.PaperParallelReader = {
  buildPositionIndex,
  buildMeasuredPositionIndex,
  shouldSuppressScrollEcho,
  clampScrollTop,
  buildPdfPositionIndex,
  resolvePdfSyncCommand,
  locateBlockAtViewport,
  buildUnitIndex,
  resolveSyncCommand,
  createSyncController,
  locateSubstringRange,
  buildFlowBlocks,
  buildReaderModel,
};
