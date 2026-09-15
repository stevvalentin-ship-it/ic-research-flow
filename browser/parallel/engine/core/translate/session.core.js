// ============================================================================
// session.core.js —— 提示词组装 + 断点续跑会话(浏览器 / Node 通用)
// 依赖:先加载 pipeline.core.js(提供 extractTerms / validateTranslation)
// ============================================================================

/**
 * 组装系统提示词:角色定义 + 任务 + 最小 Markdown/LaTeX 输出包装(不动用户提示词正文)
 * @param {{roleDefinition?:string, task?:string, wrapper?:string}} system
 */
function buildSystemPrompt(system) {
  const s = system || {};
  return [s.roleDefinition, s.task, s.wrapper].filter(Boolean).join('\n\n');
}

/**
 * 组装用户提示词:用户原文(整份)+ 工程上下文(章节/术语表/前文/当前块)。
 * 翻译原则原文完整保留,上下文作为数据附加在末尾,不修改任何原则。
 */
function buildUserPrompt(opts) {
  const parts = [opts.userPrompt || ''];
  if (opts.pass === 1) {
    parts.push(
      `\n\n【术语抽取用章级粗译】\n当前章节:${opts.chapterTitle || ''}\n章节原文:\n${opts.chapterText || ''}`,
    );
  } else {
    if (opts.chapterTitle) parts.push(`\n\n【当前章节】${opts.chapterTitle}`);
    if (opts.terms && opts.terms.length) {
      parts.push(
        `\n\n【全局术语表(翻译时保持这些译名一致)】\n` +
          opts.terms.map((t) => `${t.zh}（${t.en}${t.abbr ? ', ' + t.abbr : ''}）`).join('\n'),
      );
    }
    if (opts.priorContext) parts.push(`\n\n【前文已定稿译文片段(仅供风格一致,不要复述)】\n${opts.priorContext}`);
    parts.push(
      `\n\n【待翻译块】\n类型:${opts.block.type}\n原文:\n${opts.block.text}`,
    );
  }
  return parts.join('');
}

/** 同一论文的不同翻译引擎/实现版本必须使用独立断点缓存。 */
function buildSessionStorageKey(baseKey, engine, version) {
  return `${baseKey}:${engine}@${version}`;
}

/**
 * 断点续跑:已完成的块永不重跑;术语表已抽取则跳过第 1 遍;
 * 每个块成功后立即通过 saveState 持久化。
 *
 * @param {Array} blocks 按 order 排序的待译块
 * @param {Object} opts
 * @param {(ctx:any)=>Promise<string>} opts.translate
 * @param {()=>any} opts.loadState  返回 {byId:{}, terms:[]}
 * @param {(state:any)=>void|Promise<void>} opts.saveState
 * @param {(evt:any)=>void} [opts.onProgress]
 * @param {number} [opts.maxRetries]
 * @param {string} [opts.systemPrompt]
 * @param {string} [opts.userPrompt]
 */
async function runResumableTranslation(blocks, opts) {
  const P = globalThis.PaperParallelPipeline;
  if (!P) throw new Error('请先加载 pipeline.core.js');

  const maxRetries = opts.maxRetries ?? 2;
  const onProgress = opts.onProgress || (() => {});
  const state = (await opts.loadState()) || { byId: {}, terms: [] };
  state.byId = state.byId || {};
  state.terms = state.terms || [];
  const stats = { pass1Chapters: 0, pass2Blocks: 0, done: 0, failed: 0, retries: 0, resumed: 0 };
  const terms = [...state.terms];
  const termKeys = new Set(terms.map((t) => t.zh + '|' + t.en));
  const addTerms = (found) => {
    for (const t of found) {
      const k = t.zh + '|' + t.en;
      if (!termKeys.has(k)) {
        termKeys.add(k);
        terms.push(t);
      }
    }
  };

  // ---------- 第 1 遍:术语抽取(已有术语表则跳过) ----------
  const chapters = [];
  let cur = null;
  for (const b of blocks) {
    if (b.type === 'section') {
      cur = { title: b.text, blocks: [] };
      chapters.push(cur);
    } else if (cur) cur.blocks.push(b);
  }
  if (!terms.length) {
    for (const ch of chapters) {
      const chapterText = ch.blocks.map((b) => b.text).join('\n').slice(0, 6000);
      if (!chapterText.trim()) continue;
      stats.pass1Chapters++;
      onProgress({ phase: 'pass1', chapter: ch.title, status: 'running' });
      try {
        const rough = await opts.translate({
          pass: 1,
          chapterTitle: ch.title,
          chapterText,
          terms: [],
          systemPrompt: opts.systemPrompt,
          userPrompt: opts.userPrompt,
          attempt: 0,
        });
        addTerms(P.extractTerms(rough));
      } catch (e) {
        onProgress({ phase: 'pass1', chapter: ch.title, status: 'failed', error: String(e) });
      }
    }
    state.terms = terms;
    await opts.saveState(state);
  }

  // ---------- 第 2 遍:逐块续跑 ----------
  const out = [];
  let priorContext = '';

  for (const b of blocks) {
    const saved = state.byId[b.id];
    if (saved && saved.status === 'done' && saved.zhText) {
      stats.resumed++;
      stats.done++;
      out.push({ ...b, zhText: saved.zhText, status: 'done', attempts: saved.attempts || 1, resumed: true });
      priorContext = (b.text || '').slice(-200) + '\n' + saved.zhText.slice(-200);
      onProgress({ phase: 'pass2', blockId: b.id, status: 'resumed' });
      continue;
    }

    stats.pass2Blocks++;
    onProgress({ phase: 'pass2', blockId: b.id, status: 'running', attempt: 0 });
    let zh = null;
    let lastError = null;
    let attemptsUsed = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attemptsUsed = attempt + 1;
      try {
        const raw = await opts.translate({
          pass: 2,
          block: b,
          chapterTitle: chapters.find((c) => c.blocks.includes(b))?.title,
          terms,
          priorContext: priorContext.slice(-400),
          systemPrompt: opts.systemPrompt,
          userPrompt: opts.userPrompt,
          attempt,
        });
        const v = P.validateTranslation(raw, b.text);
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
      const rec = { ...b, zhText: zh, status: 'done', attempts: attemptsUsed, error: undefined };
      out.push(rec);
      state.byId[b.id] = { zhText: zh, status: 'done', attempts: attemptsUsed };
      await opts.saveState(state); // 每块成功后立即持久化(断点续跑的关键)
      priorContext = (b.text || '').slice(-200) + '\n' + zh.slice(-200);
      onProgress({ phase: 'pass2', blockId: b.id, status: 'done', attempt: attemptsUsed - 1 });
    } else {
      stats.failed++;
      const rec = { ...b, zhText: '', status: 'failed', attempts: attemptsUsed, error: String(lastError && lastError.message || lastError) };
      out.push(rec);
      state.byId[b.id] = { status: 'failed', error: rec.error };
      await opts.saveState(state);
      onProgress({ phase: 'pass2', blockId: b.id, status: 'failed', error: rec.error });
    }
  }

  return {
    blocks: out,
    terms,
    stats,
    assembled: out.filter((b) => b.status === 'done').map((b) => b.zhText).join('\n\n'),
  };
}

const __rootSession = typeof globalThis !== 'undefined' ? globalThis : this;
__rootSession.PaperParallelTranslateSession = {
  buildSystemPrompt,
  buildUserPrompt,
  buildSessionStorageKey,
  runResumableTranslation,
};
