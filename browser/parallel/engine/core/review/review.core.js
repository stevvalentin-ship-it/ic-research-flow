// ============================================================================
// review.core.js —— AI 复审 + 人工终审门禁 + 项目包打包校验(浏览器/Node 通用)
// 依赖:无(规则审核 issues 由 audit.core.js 传入)
// ============================================================================

/**
 * 从 LLM 输出中解析 JSON(容忍 ```json 围栏与前后杂文)。
 */
function parseLlmJson(text) {
  const s = String(text || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * AI 复审:逐对交给审校模型,期望返回 {issues:[{severity,message,blockId?}]}。
 * @param {Array<{enBlockId:string,zhBlockId:string,enText:string,zhText:string}>} pairs
 * @param {Object} opts {translate:(ctx:any)=>Promise<string>, systemPrompt?, userPrompt?, onProgress?}
 */
async function runAiReview(pairs, opts) {
  const issues = [];
  let n = 0;
  const add = (severity, blockId, message) =>
    issues.push({ id: 'ai-' + (++n), kind: 'ai', severity: severity === 'error' ? 'error' : 'warn', blockId, message, rule: 'AI', resolved: false });

  for (const p of pairs) {
    if (opts.onProgress) opts.onProgress({ phase: 'ai-review', blockId: p.enBlockId, status: 'running' });
    let parsed = null;
    try {
      const raw = await opts.translate({
        enBlockId: p.enBlockId,
        zhBlockId: p.zhBlockId,
        enText: p.enText,
        zhText: p.zhText,
        systemPrompt: opts.systemPrompt || '',
        userPrompt: opts.userPrompt || '',
      });
      parsed = parseLlmJson(raw);
    } catch (e) {
      parsed = { issues: [{ severity: 'warn', message: '审校模型调用失败:' + String(e && e.message || e) }] };
    }
    if (!parsed) {
      add('warn', p.enBlockId, '审校模型返回无法解析,按警告处理');
      continue;
    }
    for (const it of parsed.issues || []) {
      add(it.severity === 'error' ? 'error' : 'warn', it.blockId || p.enBlockId, it.message || '未说明问题');
    }
  }
  return { issues, pass: issues.every((i) => i.severity !== 'error') };
}

/** 合并规则审核 + AI 复审 issue;返回未消解错误数。 */
function combineIssues(ruleIssues, aiIssues) {
  const all = [...(ruleIssues || []), ...(aiIssues || [])];
  return {
    issues: all,
    unresolvedErrors: all.filter((i) => i.severity === 'error' && !i.resolved).length,
    unresolvedWarns: all.filter((i) => i.severity === 'warn' && !i.resolved).length,
  };
}

/** 人工终审门禁:仅当不存在未消解 error 时通过。 */
function isApproved(issues) {
  return issues.every((i) => i.severity !== 'error' || i.resolved === true);
}

/** 人工消解/重开。 */
function resolveIssue(issues, id, resolved = true) {
  const it = issues.find((i) => i.id === id);
  if (it) it.resolved = resolved;
  return issues;
}

/** 项目包:双文档 + 对齐 + span + 术语 + 审核记录 + 校验和。 */
function buildProjectPackage(input) {
  const payload = {
    schema: 'paper-parallel.project.v1',
    mode: input.mode || 'A',
    enDoc: input.enDoc || null,
    zhDoc: input.zhDoc || null,
    units: input.units || [],
    spans: input.spans || [],
    terms: input.terms || [],
    issues: input.issues || [],
    auditPassed: input.auditPassed === true,
    generatedAt: new Date().toISOString(),
  };
  const checksum = fnv1a(JSON.stringify(payload));
  return { ...payload, checksum };
}

/** 校验项目包:版本/必填字段/校验和/对齐引用完整性。 */
function validateProjectPackage(pkg) {
  const errors = [];
  if (!pkg || pkg.schema !== 'paper-parallel.project.v1') errors.push('schema 不匹配');
  if (!Array.isArray(pkg.units)) errors.push('units 缺失');
  if (!Array.isArray(pkg.spans)) errors.push('spans 缺失');
  if (!Array.isArray(pkg.issues)) errors.push('issues 缺失');
  if (pkg.auditPassed !== true) errors.push('auditPassed 不为 true(未经人工终审门禁)');
  if (pkg && typeof pkg.checksum === 'string') {
    const copy = { ...pkg };
    delete copy.checksum;
    if (fnv1a(JSON.stringify(copy)) !== pkg.checksum) errors.push('checksum 不匹配(数据被篡改)');
  } else {
    errors.push('缺少 checksum');
  }
  return { ok: errors.length === 0, errors };
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const __rootReview = typeof globalThis !== 'undefined' ? globalThis : this;
__rootReview.PaperParallelReview = {
  parseLlmJson,
  runAiReview,
  combineIssues,
  isApproved,
  resolveIssue,
  buildProjectPackage,
  validateProjectPackage,
  fnv1a,
};
