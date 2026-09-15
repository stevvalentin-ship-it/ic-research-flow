// ============================================================================
// alignBlocks.core.js —— 场景 B:文档级锚点 + 块级对齐 + 人工锚点校准
// 依赖 align.core.js(不强制;锚点/块级 DP 独立实现)。
// 思路:强锚点先锁大局 -> 锚点间逐段做块级 DP -> 人工校准覆盖锚点后重排。
// ============================================================================

/**
 * 归一化锚点标签:跨语言统一为稳定 key。
 * - 章节:'1 Introduction' / '1 引言' / '1.1 Motivation' -> sec1 / sec1.1
 * - 图题:'Figure 1' / 'Fig. 1' / '图 1' -> fig1
 * - 表题:'Table 1' / '表 1' -> tab1
 * @param {string} type
 * @param {string} text
 * @returns {string|null}
 */
function normalizeAnchorLabel(type, text) {
  const t = String(text || '').trim();
  if (type === 'section') {
    const m = t.match(/^\s*(\d+(?:\.\d+)*)\s/);
    if (m) return 'sec' + m[1];
    if (/^(abstract|摘要)/i.test(t)) return 'abstract';
    if (/^(references|bibliography|参考文献)/i.test(t)) return 'references';
    return null;
  }
  let m = t.match(/^(?:fig(?:ure)?\.?)\s*(\d+)/i);
  if (m) return 'fig' + m[1];
  if (/^图\s*(\d+)/.test(t)) return 'fig' + t.match(/^图\s*(\d+)/)[1];
  m = t.match(/^(?:table)\s*(\d+)/i);
  if (m) return 'tab' + m[1];
  if (/^表\s*(\d+)/.test(t)) return 'tab' + t.match(/^表\s*(\d+)/)[1];
  return null;
}

/**
 * 从块序列中抽取强锚点。
 * @param {Array<{id:string,type:string,text?:string,order:number}>} blocks
 * @returns {Array<{label:string,kind:'section'|'caption',blockId:string,order:number,text:string}>}
 */
function extractAnchors(blocks) {
  const out = [];
  for (const b of blocks) {
    const label = normalizeAnchorLabel(b.type, b.text || b.caption || '');
    if (label) {
      out.push({ label, kind: b.type === 'section' ? 'section' : 'caption', blockId: b.id, order: b.order, text: (b.text || b.caption || '').trim() });
    }
  }
  return out;
}

/**
 * 按归一化 label 匹配两侧锚点;重复 label 按出现顺序配对。
 * @returns {{pairs:Array, unmatchedEn:Array, unmatchedZh:Array}}
 */
function matchAnchors(enAnchors, zhAnchors) {
  const zhByLabel = new Map();
  for (const a of zhAnchors) {
    if (!zhByLabel.has(a.label)) zhByLabel.set(a.label, []);
    zhByLabel.get(a.label).push(a);
  }
  const pairs = [];
  const unmatchedEn = [];
  const usedZh = new Set();
  for (const en of enAnchors) {
    const list = zhByLabel.get(en.label) || [];
    const zh = list.find((a) => !usedZh.has(a.blockId));
    if (zh) {
      usedZh.add(zh.blockId);
      pairs.push({ label: en.label, enBlockId: en.blockId, zhBlockId: zh.blockId, source: 'auto', enOrder: en.order, zhOrder: zh.order });
    } else {
      unmatchedEn.push(en);
    }
  }
  const unmatchedZh = zhAnchors.filter((a) => !usedZh.has(a.blockId));
  return { pairs, unmatchedEn, unmatchedZh };
}

/**
 * 人工锚点校准:应用用户覆盖(新增/改绑/删除)。
 * override = {label, enBlockId?, zhBlockId?};zhBlockId 为 null 表示删除该锚点对;
 * 有 enBlockId+zhBlockId 则新增/改绑。
 * @returns {pairs, issues}
 */
function applyManualAnchorOverrides(pairs, overrides) {
  const issues = [];
  let out = pairs.map((p) => ({ ...p }));
  for (const ov of overrides || []) {
    if (!ov.label) { issues.push('override 缺 label'); continue; }
    if (ov.zhBlockId === null || ov.zhBlockId === undefined && ov.enBlockId === undefined) {
      const before = out.length;
      out = out.filter((p) => !(p.label === ov.label));
      if (out.length === before) issues.push(`删除失败:未找到锚点 ${ov.label}`);
      continue;
    }
    const idx = out.findIndex((p) => p.label === ov.label);
    const next = { label: ov.label, enBlockId: ov.enBlockId, zhBlockId: ov.zhBlockId, source: 'manual' };
    if (idx >= 0) out[idx] = { ...out[idx], ...next };
    else out.push(next);
  }
  return { pairs: out, issues };
}

/**
 * 块级 DP:1:0 / 0:1 / 1:1 / 2:1 / 1:2。
 * @param {Array} en
 * @param {Array} zh
 * @param {(enBlock:any, zhBlock:any)=>Promise<number>|number} scoreFn 0..1
 */
async function alignBlockRange(en, zh, scoreFn, opts) {
  const unmatchedPenalty = opts?.unmatchedPenalty ?? 0.8;
  const n = en.length;
  const m = zh.length;
  const scores = [];
  for (let i = 0; i < n; i++) {
    scores[i] = [];
    for (let j = 0; j < m; j++) scores[i][j] = Math.max(0, Math.min(1, Number(await scoreFn(en[i], zh[j])) || 0));
  }
  const NEG = -1e9;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(NEG));
  const back = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
  dp[0][0] = 0;
  const take = (i, j, di, dj, cost, tag) => {
    if (i + di > n || j + dj > m) return;
    const ni = i + di;
    const nj = j + dj;
    const nd = dp[i][j] + cost;
    if (nd > dp[ni][nj] + 1e-9) {
      dp[ni][nj] = nd;
      back[ni][nj] = { i, j, tag };
    }
  };
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (dp[i][j] === NEG) continue;
      if (i < n && j < m) {
        take(i, j, 1, 1, scores[i][j], '1:1');
        if (i + 1 < n) take(i, j, 2, 1, scores[i][j] + scores[i + 1][j] - unmatchedPenalty - 1e-6, '2:1');
        if (j + 1 < m) take(i, j, 1, 2, scores[i][j] + scores[i][j + 1] - unmatchedPenalty - 1e-6, '1:2');
      }
      if (i < n) take(i, j, 1, 0, -unmatchedPenalty, '1:0');
      if (j < m) take(i, j, 0, 1, -unmatchedPenalty, '0:1');
    }
  }
  const raw = [];
  let ci = n;
  let cj = m;
  while (ci > 0 || cj > 0) {
    const b = back[ci][cj];
    if (!b) break;
    raw.unshift(b);
    ci = b.i;
    cj = b.j;
  }
  const units = [];
  let ei = 0;
  let zj = 0;
  for (const b of raw) {
    let enIdx = [];
    let zhIdx = [];
    let conf = 0;
    if (b.tag === '1:1') { enIdx = [ei]; zhIdx = [zj]; conf = scores[ei][zj]; }
    else if (b.tag === '2:1') { enIdx = [ei, ei + 1]; zhIdx = [zj]; conf = (scores[ei][zj] + scores[ei + 1][zj]) / 2; }
    else if (b.tag === '1:2') { enIdx = [ei]; zhIdx = [zj, zj + 1]; conf = (scores[ei][zj] + scores[ei][zj + 1]) / 2; }
    else if (b.tag === '1:0') { enIdx = [ei]; conf = 0; }
    else if (b.tag === '0:1') { zhIdx = [zj]; conf = 0; }
    units.push({ enIndices: enIdx, zhIndices: zhIdx, confidence: conf });
    ei += b.tag === '2:1' ? 2 : (b.tag === '1:0' || b.tag === '1:1' || b.tag === '1:2' ? 1 : 0);
    zj += b.tag === '1:2' ? 2 : (b.tag === '0:1' || b.tag === '1:1' || b.tag === '2:1' ? 1 : 0);
  }
  const matched = units.filter((u) => u.enIndices.length && u.zhIndices.length);
  return { units, avgConfidence: matched.length ? matched.reduce((a, u) => a + u.confidence, 0) / matched.length : 0 };
}

/**
 * 场景 B 主流程:锚点锁大局 -> 段内块级对齐。
 * @param {Array} enBlocks
 * @param {Array} zhBlocks
 * @param {Object} opts {scoreFn, manualOverrides?, minConfidence?}
 */
async function alignBlocksWithAnchors(enBlocks, zhBlocks, opts) {
  const scoreFn = opts.scoreFn;
  const minConfidence = opts.minConfidence ?? 0.3;
  const enAnchors = extractAnchors(enBlocks);
  const zhAnchors = extractAnchors(zhBlocks);
  let { pairs, unmatchedEn, unmatchedZh } = matchAnchors(enAnchors, zhAnchors);
  let calibrationIssues = [];
  if (opts.manualOverrides && opts.manualOverrides.length) {
    const cal = applyManualAnchorOverrides(pairs, opts.manualOverrides);
    pairs = cal.pairs;
    calibrationIssues = cal.issues;
  }
  pairs.sort((a, b) => (a.enOrder ?? 0) - (b.enOrder ?? 0));

  const cut = (list, id) => list.findIndex((b) => b.id === id);

  const units = [];
  let cursorEn = 0;
  let cursorZh = 0;

  for (const p of pairs) {
    const ei = cut(enBlocks, p.enBlockId);
    const zi = cut(zhBlocks, p.zhBlockId);
    if (ei < 0 || zi < 0) continue; // 人工锚点指向不存在的块,跳过并在 issues 提示
    // 锚点之前的段
    if (ei > cursorEn || zi > cursorZh) {
      const enSeg = enBlocks.slice(cursorEn, ei);
      const zhSeg = zhBlocks.slice(cursorZh, zi);
      const r = await alignBlockRange(enSeg, zhSeg, scoreFn);
      for (const u of r.units) {
        units.push({
          enBlockIds: u.enIndices.map((i) => enSeg[i].id),
          zhBlockIds: u.zhIndices.map((j) => zhSeg[j].id),
          confidence: u.confidence,
          level: u.enIndices.length && u.zhIndices.length ? 'paragraph' : 'section',
        });
      }
    }
    units.push({ enBlockIds: [p.enBlockId], zhBlockIds: [p.zhBlockId], confidence: 1, level: 'paragraph', anchor: p.label, anchorSource: p.source });
    cursorEn = ei + 1;
    cursorZh = zi + 1;
  }
  // 最后一对锚点之后的段
  if (cursorEn < enBlocks.length || cursorZh < zhBlocks.length) {
    const enSeg = enBlocks.slice(cursorEn);
    const zhSeg = zhBlocks.slice(cursorZh);
    const r = await alignBlockRange(enSeg, zhSeg, scoreFn);
    for (const u of r.units) {
      units.push({
        enBlockIds: u.enIndices.map((i) => enSeg[i].id),
        zhBlockIds: u.zhIndices.map((j) => zhSeg[j].id),
        confidence: u.confidence,
        level: u.enIndices.length && u.zhIndices.length ? 'paragraph' : 'section',
      });
    }
  }

  const matched = units.filter((u) => u.enBlockIds.length && u.zhBlockIds.length);
  const avgConfidence = matched.length ? matched.reduce((a, u) => a + u.confidence, 0) / matched.length : 0;
  return {
    units,
    anchors: pairs,
    unmatchedAnchors: { en: unmatchedEn, zh: unmatchedZh },
    calibrationIssues,
    avgConfidence,
    degraded: avgConfidence < minConfidence,
  };
}

const __rootAlignBlocks = typeof globalThis !== 'undefined' ? globalThis : this;
__rootAlignBlocks.PaperParallelAlignBlocks = {
  normalizeAnchorLabel,
  extractAnchors,
  matchAnchors,
  applyManualAnchorOverrides,
  alignBlockRange,
  alignBlocksWithAnchors,
};
