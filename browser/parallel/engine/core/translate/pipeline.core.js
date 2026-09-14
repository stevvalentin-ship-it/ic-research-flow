// ============================================================================
// pipeline.core.js —— 翻译管线核心(浏览器 / Node 通用,零依赖)
// 对应实施计划 Sprint 3:
//   两遍法:第1遍 章级粗译抽取全局术语表;第2遍 按块串行精译并注入术语表
//   按块串行、失败重试(默认2次)、校验、断点状态、进度回调、块序保序
// LLM 调用完全由调用方注入(浏览器里可接 fetch->DeepSeek,测试里可用 mock),
// 因此核心是纯编排逻辑。
//
// 双环境加载同 paginator.core.js:浏览器 <script src>;Node import 后读 globalThis.
// ============================================================================

/**
 * @typedef {Object} TranslateBlock
 * @property {string} id
 * @property {string} type  title|authors|abstract|keywords|section|paragraph|reference|caption
 * @property {string} text
 * @property {string} [parentSectionId]
 * @property {number} order
 */

/**
 * @typedef {Object} TermEntry
 * @property {string} zh
 * @property {string} en
 * @property {string} [abbr]
 */

/**
 * @typedef {Object} PipelineOptions
 * @property {(ctx: TranslateContext) => Promise<string>} translate
 * @property {(evt: any) => void} [onProgress]
 * @property {() => boolean} [shouldStop]
 * @property {number} [maxRetries]
 * @property {string} [systemPrompt]
 * @property {string} [userPrompt]
 */

/**
 * @typedef {Object} TranslateContext
 * @property {1|2} pass
 * @property {TranslateBlock} [block]
 * @property {string} [chapterTitle]
 * @property {string} [chapterText]
 * @property {TermEntry[]} terms
 * @property {string} [priorContext]
 * @property {string} systemPrompt
 * @property {string} userPrompt
 * @property {number} attempt
 */

/**
 * 从译文/粗译文本中抽取"中文名称（English Full Name, ABBR）"格式的术语。
 * @param {string} text
 * @returns {TermEntry[]}
 */
function extractTerms(text) {
  const re = /([\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z· -]{0,30}?)（([A-Za-z][A-Za-z0-9 -]{2,60}?)(?:,\s*([A-Za-z0-9-]{2,10}))?）/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    let zh = (m[1] || '').trim().replace(/^(?:(?:以及|并且|或者|和|与|及|、|,|，)\s*)+/, '');
    const en = (m[2] || '').trim();
    const abbr = (m[3] || '').trim();
    if (!zh || !en) continue;
    const key = zh + '|' + en;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abbr ? { zh, en, abbr } : { zh, en });
  }
  return out;
}

/**
 * 译文校验:非空、无"翻译说明/总结"污染、非原样英文(超短块除外)。
 * @param {string} text
 * @param {string} source
 */
function validateTranslation(text, source) {
  if (!text || !text.trim()) return { ok: false, reason: '空译文' };
  const t = text.trim();
  if (/^(翻译说明|译文说明|说明:|注意:|作为翻译|以下为译文|这里是翻译)/.test(t)) {
    return { ok: false, reason: '译文带说明性前缀' };
  }
  if (/翻译说明|请见谅|抱歉,我无法|I cannot translate/i.test(t)) {
    return { ok: false, reason: '检测到翻译说明或拒译文本' };
  }
  // 英文源文至少 20 字符时,不允许译文几乎全英文(说明没翻)
  if (source.trim().length >= 20) {
    const latin = (t.match(/[A-Za-z]/g) || []).length;
    if (latin > t.length * 0.8) return { ok: false, reason: '译文几乎全为英文,疑似未翻译' };
  }
  return { ok: true };
}

function extractStructuralNumbers(text) {
  const token = /[+\-−]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+\-−]?\d+)?(?:\s*[×x]\s*10\s*\^\s*[+\-−]?\d+)?/g;
  return String(text || '').match(token) || [];
}

/**
 * 离线端到端测试用结构化 mock：不追求语义翻译质量，只保证审核依赖的
 * 章节/图表编号与正文数字不丢失。
 * @param {TranslateContext} ctx
 * @returns {string}
 */
function mockTranslatePreservingStructure(ctx) {
  if (ctx.pass === 1) {
    return '零知识虚拟机（Zero-Knowledge Virtual Machine, zkVM）。执行轨迹（Trace）。加速器（Accelerator）。';
  }

  const block = ctx.block || {};
  const source = String(block.text || '').trim();
  let translated;
  if (block.type === 'title') translated = '结构保真的模拟论文标题';
  else if (block.type === 'authors') translated = '模拟作者与机构信息';
  else if (block.type === 'abstract') {
    translated = '摘要——本文研究零知识虚拟机（Zero-Knowledge Virtual Machine, zkVM）的硬件加速。';
  } else if (block.type === 'section') {
    translated = source.replace(/^(\d+(?:\.\d+)*).*/, (_m, number) => `${number} 节`);
  } else if (block.type === 'caption') {
    const enLabel = source.match(/^(fig(?:ure)?\.?|table|algorithm)\s*(\d+)/i);
    const zhLabel = source.match(/^([图表])\s*(\d+)/);
    if (enLabel) {
      const kind = /^fig/i.test(enLabel[1]) ? '图' : /^table/i.test(enLabel[1]) ? '表' : '算法';
      translated = `${kind} ${enLabel[2]}：模拟说明`;
    } else if (zhLabel) {
      translated = `${zhLabel[1]} ${zhLabel[2]}：模拟说明`;
    } else {
      translated = '模拟图表说明';
    }
  } else {
    translated = '结构保真的模拟译文。';
  }

  const outputNumbers = new Set(extractStructuralNumbers(translated));
  const missingNumbers = [...new Set(extractStructuralNumbers(source))]
    .filter((number) => !outputNumbers.has(number));
  return missingNumbers.length
    ? `${translated}（保留数字：${missingNumbers.join('、')}）`
    : translated;
}

/**
 * 两遍法翻译管线。
 * @param {TranslateBlock[]} blocks 已按 order 排序
 * @param {PipelineOptions} opts
 * @returns {Promise<{blocks:Array, terms:TermEntry[], stats:Object, transcript:Array}>}
 */
async function runTranslationPipeline(blocks, opts) {
  const maxRetries = opts.maxRetries ?? 2;
  const onProgress = opts.onProgress || (() => {});
  const shouldStop = opts.shouldStop || (() => false);
  const translate = opts.translate;
  const systemPrompt = opts.systemPrompt || '';
  const userPrompt = opts.userPrompt || '';

  const stats = { pass1Chapters: 0, pass2Blocks: 0, done: 0, failed: 0, retries: 0 };
  const transcript = [];
  const terms = [];
  const termKeys = new Set();
  const addTerms = (found) => {
    for (const t of found) {
      const k = t.zh + '|' + t.en;
      if (!termKeys.has(k)) {
        termKeys.add(k);
        terms.push(t);
      }
    }
  };

  // ---------- 第 1 遍:章级粗译,只为抽取全局术语表 ----------
  const chapters = [];
  let cur = null;
  for (const b of blocks) {
    if (b.type === 'section') {
      cur = { id: b.parentSectionId || b.id, title: b.text, blocks: [] };
      chapters.push(cur);
    } else if (cur) {
      cur.blocks.push(b);
    }
  }
  for (const ch of chapters) {
    if (shouldStop()) break;
    const chapterText = ch.blocks.map((b) => b.text).join('\n').slice(0, 6000);
    if (!chapterText.trim()) continue;
    stats.pass1Chapters++;
    onProgress({ phase: 'pass1', chapter: ch.title, status: 'running' });
    try {
      const rough = await translate({
        pass: 1,
        chapterTitle: ch.title,
        chapterText,
        terms: [],
        systemPrompt,
        userPrompt,
        attempt: 0,
      });
      const found = extractTerms(rough);
      addTerms(found);
      transcript.push({ phase: 'pass1', chapter: ch.title, ok: true, terms: found.length });
      onProgress({ phase: 'pass1', chapter: ch.title, status: 'done', terms: found.length });
    } catch (e) {
      transcript.push({ phase: 'pass1', chapter: ch.title, ok: false, error: String(e && e.message || e) });
      onProgress({ phase: 'pass1', chapter: ch.title, status: 'failed', error: String(e) });
    }
  }

  // ---------- 第 2 遍:按块串行精译 ----------
  const out = [];
  let priorContext = '';
  for (const b of blocks) {
    if (shouldStop()) break;
    stats.pass2Blocks++;
    onProgress({ phase: 'pass2', blockId: b.id, status: 'running', attempt: 0 });

    let zh = null;
    let lastError = null;
    let attemptsUsed = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attemptsUsed = attempt + 1;
      try {
        const raw = await translate({
          pass: 2,
          block: b,
          chapterTitle: chapters.find((c) => c.blocks.includes(b))?.title,
          terms,
          priorContext: priorContext.slice(-400),
          systemPrompt,
          userPrompt,
          attempt,
        });
        const v = validateTranslation(raw, b.text);
        if (!v.ok) {
          lastError = new Error(v.reason);
          if (attempt < maxRetries) stats.retries++;
          continue;
        }
        zh = raw.trim();
        break;
      } catch (e) {
        lastError = e;
        if (attempt < maxRetries) stats.retries++;
      }
    }

    if (zh !== null) {
      stats.done++;
      out.push({ ...b, zhText: zh, status: 'done', attempts: attemptsUsed });
      // 上一块译文尾部作为上下文(原文+译文拼接)
      priorContext = (b.text || '').slice(-200) + '\n' + zh.slice(-200);
      transcript.push({ phase: 'pass2', blockId: b.id, ok: true, attempts: attemptsUsed });
      onProgress({ phase: 'pass2', blockId: b.id, status: 'done', attempt: attemptsUsed - 1 });
    } else {
      stats.failed++;
      out.push({ ...b, zhText: '', status: 'failed', attempts: attemptsUsed, error: String(lastError && lastError.message || lastError) });
      transcript.push({ phase: 'pass2', blockId: b.id, ok: false, error: String(lastError && lastError.message || lastError) });
      onProgress({ phase: 'pass2', blockId: b.id, status: 'failed', error: String(lastError && lastError.message || lastError) });
    }
  }

  return {
    blocks: out,
    terms,
    stats,
    transcript,
    assembled: out.filter((b) => b.status === 'done').map((b) => b.zhText).join('\n\n'),
  };
}

const __rootPipeline = typeof globalThis !== 'undefined' ? globalThis : this;
__rootPipeline.PaperParallelPipeline = {
  extractTerms,
  validateTranslation,
  mockTranslatePreservingStructure,
  runTranslationPipeline,
};
