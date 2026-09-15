// ============================================================================
// align.core.js —— 对齐引擎核心(浏览器 / Node 通用,零依赖)
// 对应实施计划 Sprint 4:
//   句级对齐:DP 全局最优,允许 1:0 / 0:1 / 1:1 / 1:2 / 2:1
//   三级降级:sentence -> paragraph -> section(本文件实现前两级,章节级由调用方包装)
//   词级 span:LLM 直出 + 双端子串校验,失败回退整句
// 语义打分 judge 由调用方注入(真实场景用 DeepSeek;测试用确定性关键词打分)。
// ============================================================================

/**
 * 分句:中英文标点断句,保留句末标点。
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  if (!text) return [];
  // 先把常见编号/缩写点保护住(e.g. Fig. 1 / 18.3),再按句末标点切
  const protectedText = String(text)
    // A URL's dots belong to its host/path; retain a trailing sentence dot.
    .replace(/https?:\/\/[^\s<>"）)]+/gi, (url) => {
      const body = url.replace(/[.!?;。！？；]+$/u, '');
      return body.replace(/\./g, '\u0001') + url.slice(body.length);
    })
    .replace(/(Fig\.|Figs\.|Eq\.|Eqs\.|e\.g\.|i\.e\.|et al\.)/gi, (m) => m.replace(/\./g, '\u0001'))
    .replace(/(\d)\.(\d)/g, '$1\u0001$2');
  const parts = protectedText.split(/(?<=[。！？!?;；.．])\s*|\n+/);
  const out = [];
  for (const p of parts) {
    // U+0001 is an internal sentence-splitting sentinel introduced above.
    // eslint-disable-next-line no-control-regex
    const s = p.replace(/\u0001/g, '.').trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * 归一化:去空白、小写,用于子串校验。
 * @param {string} s
 */
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[\s\u3000]+/g, ' ').trim();
}

/**
 * 对齐一个句对内的词级 span:每个 span 必须分别是英文句与中文句的子串。
 * 非法项丢弃;保留合法项并按英文出现位置排序。
 * @param {string} enText
 * @param {string} zhText
 * @param {Array<{en:string,zh:string}>} spans
 * @returns {Array<{en:string,zh:string,validated:boolean}>}
 */
function validateSpans(enText, zhText, spans) {
  if (!spans || !spans.length) return [];
  const enNorm = normalize(enText);
  const zhNorm = normalize(zhText);
  const out = [];
  const seen = new Set();
  for (const sp of spans) {
    const e = normalize(sp.en);
    const z = normalize(sp.zh);
    if (!e || !z) continue;
    const key = e + '|' + z;
    if (seen.has(key)) continue;
    seen.add(key);
    if (enNorm.includes(e) && zhNorm.includes(z)) {
      out.push({ en: sp.en, zh: sp.zh, validated: true });
    }
  }
  out.sort((a, b) => normalize(a.en).localeCompare(normalize(b.en)));
  return out;
}

/**
 * 句级对齐 DP。
 * 允许操作:1:1、1:0、0:1、1:2、2:1;分数 = 1 - 语义距离(0..1)。
 * 返回 {units:[{enIndices:number[],zhIndices:number[],confidence}], avgConfidence, matchedEn, matchedZh}
 * @param {string[]} en
 * @param {string[]} zh
 * @param {(enIdx:number, zhIdx:number)=>Promise<number>|number} scoreFn 返回 0..1
 * @param {{unmatchedPenalty?:number, minConfidence?:number}} [opts]
 */
async function alignSentenceSequences(en, zh, scoreFn, opts) {
  const unmatchedPenalty = opts?.unmatchedPenalty ?? 0.85;
  const minConfidence = opts?.minConfidence ?? 0.35;
  const n = en.length;
  const m = zh.length;

  // 预取分数
  const scores = [];
  for (let i = 0; i < n; i++) {
    scores[i] = [];
    for (let j = 0; j < m; j++) {
      const v = await scoreFn(i, j);
      scores[i][j] = Math.max(0, Math.min(1, Number(v) || 0));
    }
  }

  const NEG = -1e9;
  // dp[i][j] = 对齐 en 前 i 句 / zh 前 j 句的最小代价
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(NEG));
  const back = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
  dp[0][0] = 0;

  const take = (i, j, di, dj, cost, tag, k1 = 1, k2 = 1) => {
    if (i + di > n || j + dj > m) return;
    const ni = i + di;
    const nj = j + dj;
    const nd = dp[i][j] + cost;
    if (nd > dp[ni][nj] + 1e-9) {
      dp[ni][nj] = nd;
      back[ni][nj] = { i, j, tag, k1, k2 };
    }
  };

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (dp[i][j] === NEG) continue;
      if (i < n && j < m) {
        const sc = scores[i][j];
        take(i, j, 1, 1, sc, '1:1');
        if (i + 1 < n) take(i, j, 2, 1, scores[i][j] + scores[i + 1][j] - unmatchedPenalty - 1e-6, '2:1', 2, 1); // 2 en -> 1 zh
        if (j + 1 < m) take(i, j, 1, 2, scores[i][j] + scores[i][j + 1] - unmatchedPenalty - 1e-6, '1:2', 1, 2); // 1 en -> 2 zh
      }
      if (i < n) take(i, j, 1, 0, -unmatchedPenalty, '1:0');
      if (j < m) take(i, j, 0, 1, -unmatchedPenalty, '0:1');
    }
  }

  // 回溯
  const raw = [];
  let ci = n;
  let cj = m;
  while (ci > 0 || cj > 0) {
    const b = back[ci][cj];
    if (!b) break; // 不应发生
    raw.unshift(b);
    ci = b.i;
    cj = b.j;
  }

  const units = [];
  let ei = 0;
  let zj = 0;
  for (const b of raw) {
    let enIndices = [];
    let zhIndices = [];
    let conf = 0;
    if (b.tag === '1:1') {
      enIndices = [ei];
      zhIndices = [zj];
      conf = scores[ei][zj];
    } else if (b.tag === '2:1') {
      enIndices = [ei, ei + 1];
      zhIndices = [zj];
      conf = (scores[ei][zj] + scores[ei + 1][zj]) / 2;
    } else if (b.tag === '1:2') {
      enIndices = [ei];
      zhIndices = [zj, zj + 1];
      conf = (scores[ei][zj] + scores[ei][zj + 1]) / 2;
    } else if (b.tag === '1:0') {
      enIndices = [ei];
      conf = 0;
    } else if (b.tag === '0:1') {
      zhIndices = [zj];
      conf = 0;
    }
    units.push({ enIndices, zhIndices, confidence: conf });
    ei += b.tag === '2:1' ? 2 : b.tag === '1:0' || b.tag === '1:1' || b.tag === '1:2' ? 1 : 0;
    zj += b.tag === '1:2' ? 2 : b.tag === '0:1' || b.tag === '1:1' || b.tag === '2:1' ? 1 : 0;
  }

  const matched = units.filter((u) => u.enIndices.length && u.zhIndices.length);
  const avgConfidence = matched.length ? matched.reduce((a, u) => a + u.confidence, 0) / matched.length : 0;
  return {
    units,
    avgConfidence,
    matchedEn: matched.reduce((a, u) => a + u.enIndices.length, 0),
    matchedZh: matched.reduce((a, u) => a + u.zhIndices.length, 0),
    minConfidence,
  };
}

/**
 * 一个块对的完整对齐:
 * 1) 分句 + DP 句级对齐
 * 2) 平均置信度低于阈值 -> 降级为整段(paragraph level)
 * 3) 每个句对做词级 span 校验(失败回退为空=整句高亮)
 * @param {{id:string,text:string}} enBlock
 * @param {{id:string,text:string}} zhBlock
 * @param {Object} opts {scoreFn, spansForPair?, minConfidence?}
 */
async function alignBlockPair(enBlock, zhBlock, opts) {
  const en = splitSentences(enBlock.text || '');
  const zh = splitSentences(zhBlock.text || '');
  const minConfidence = opts.minConfidence ?? 0.35;
  const result = await alignSentenceSequences(en, zh, opts.scoreFn, { minConfidence });

  if (result.avgConfidence < minConfidence || !en.length || !zh.length) {
    return {
      level: 'paragraph',
      enBlockId: enBlock.id,
      zhBlockId: zhBlock.id,
      enSentences: en,
      zhSentences: zh,
      confidence: result.avgConfidence,
      units: [{ enIndices: en.map((_, i) => i), zhIndices: zh.map((_, j) => j), confidence: result.avgConfidence, fallback: true }],
      spans: [],
    };
  }

  const units = [];
  const spans = [];
  for (const u of result.units) {
    if (u.enIndices.length && u.zhIndices.length) {
      const enText = u.enIndices.map((i) => en[i]).join(' ');
      const zhText = u.zhIndices.map((j) => zh[j]).join('');
      let pairSpans = [];
      if (opts.spansForPair) {
        try {
          pairSpans = await opts.spansForPair({ enText, zhText, enIndices: u.enIndices, zhIndices: u.zhIndices });
        } catch {
          pairSpans = [];
        }
      }
      const valid = validateSpans(enText, zhText, Array.isArray(pairSpans) ? pairSpans : []);
      if (valid.length) spans.push(...valid.map((s) => ({ ...s, enIndices: u.enIndices, zhIndices: u.zhIndices })));
      units.push({ enIndices: u.enIndices, zhIndices: u.zhIndices, confidence: u.confidence, spans: valid });
    } else {
      units.push({ ...u, spans: [] });
    }
  }

  return {
    level: 'sentence',
    enBlockId: enBlock.id,
    zhBlockId: zhBlock.id,
    enSentences: en,
    zhSentences: zh,
    confidence: result.avgConfidence,
    units,
    spans,
  };
}

const __rootAlign = typeof globalThis !== 'undefined' ? globalThis : this;
__rootAlign.PaperParallelAlign = { splitSentences, normalize, validateSpans, alignSentenceSequences, alignBlockPair };
