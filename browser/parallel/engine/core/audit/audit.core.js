// ============================================================================
// audit.core.js —— 二次审核第一关:规则自动审核(浏览器 / Node 通用,零依赖)
// 规则来自冻结计划:
//   R1 块序列守恒(figure/table/equation 顺序一致)
//   R2 章节编号守恒
//   R3 图/表/公式/参考文献数量守恒
//   R4 每个英文文字块都有非空译文(按翻译/对齐配对检查)
//   R5 行内公式标记数量偏差(简化:$...$ 数量)
//   R6 术语首次出现格式(缩写缺失警告)
//   R7 译文无"翻译说明/总结"污染
//   R8 数字抽样一致性(英->中数字缺失即警告)
// 门禁:存在 error 级别 issue 即不通过;warn 不阻塞但列出。
// ============================================================================

/** @typedef {{id:string,type:string,text?:string,order:number}} AuditBlock */
/** @typedef {{enBlockId:string, zhBlockId:string, zhText:string}} TranslationPair */

function issue(id, severity, blockId, message, rule) {
  return { id, kind: 'rule', severity, blockId, message, rule, resolved: false };
}

function extractSectionNumbers(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type !== 'section') continue; // 只统计章节块,参考文献/表格行不算
    const m = String(b.text || '').trim().match(/^\s*(\d+(?:\.\d+)*)\s/);
    if (m) out.push(m[1]);
  }
  return out;
}

function extractNumberedLabels(blocks) {
  const out = [];
  for (const b of blocks) {
    const t = String(b.text || '').trim();
    let m = t.match(/^(?:fig(?:ure)?\.?)\s*(\d+)/i);
    if (m) { out.push({ label: 'fig' + m[1], id: b.id, order: b.order }); continue; }
    if (/^图\s*(\d+)/.test(t)) { out.push({ label: 'fig' + t.match(/^图\s*(\d+)/)[1], id: b.id, order: b.order }); continue; }
    m = t.match(/^(?:table)\s*(\d+)/i);
    if (m) { out.push({ label: 'tab' + m[1], id: b.id, order: b.order }); continue; }
    if (/^表\s*(\d+)/.test(t)) { out.push({ label: 'tab' + t.match(/^表\s*(\d+)/)[1], id: b.id, order: b.order }); continue; }
    m = t.match(/^\((\d+)\)\s*$/);
    if (m) out.push({ label: 'eq' + m[1], id: b.id, order: b.order });
  }
  return out;
}

function extractNumbers(text) {
  return (String(text || '').match(/\d+(?:\.\d+)?/g) || []).map(Number);
}

/**
 * 规则审核主入口。
 * @param {Object} input {enBlocks:AuditBlock[], zhBlocks:AuditBlock[], pairs?:TranslationPair[], terms?:Array<{zh:string,en:string,abbr?:string}>}
 * @returns {{issues:Array, pass:boolean, errors:number, warns:number, report:Object}}
 */
function runRuleAudit(input) {
  const enBlocks = input.enBlocks || [];
  const zhBlocks = input.zhBlocks || [];
  const pairs = input.pairs || [];
  const terms = input.terms || [];
  // 场景B:对齐引擎明确输出 1:0(英文独有)的块,属于待人工确认而非错误
  const allowUnpaired = new Set(input.allowUnpaired || []);
  const issues = [];
  let n = 0;
  const add = (severity, blockId, message, rule) => issues.push(issue('audit-' + (++n), severity, blockId, message, rule));

  // R1 编号对象顺序守恒(figure/table/equation)
  const enLabels = extractNumberedLabels(enBlocks).map((x) => x.label);
  const zhLabels = extractNumberedLabels(zhBlocks).map((x) => x.label);
  if (JSON.stringify(enLabels) !== JSON.stringify(zhLabels)) {
    add('error', undefined, `编号对象序列不一致:EN=[${enLabels.join(',')}] ZH=[${zhLabels.join(',')}]`, 'R1');
  }

  // R2 章节编号守恒
  const enSec = extractSectionNumbers(enBlocks);
  const zhSec = extractSectionNumbers(zhBlocks);
  const missingSec = enSec.filter((s) => !zhSec.includes(s));
  const extraSec = zhSec.filter((s) => !enSec.includes(s));
  if (missingSec.length || extraSec.length) {
    add('error', undefined, `章节编号不一致:EN 缺失于 ZH=[${missingSec.join(',')}],ZH 多余=[${extraSec.join(',')}]`, 'R2');
  }

  // R3 数量守恒
  const count = (list, types) => list.filter((b) => types.includes(b.type)).length;
  const CHK = [
    ['figure', ['figure']],
    ['table', ['table']],
    ['equation', ['equation']],
    ['reference', ['reference']],
  ];
  for (const [name, types] of CHK) {
    const a = count(enBlocks, types);
    const b = count(zhBlocks, types);
    if (a !== b) add('error', undefined, `${name} 数量不一致:EN=${a} ZH=${b}`, 'R3');
  }

  // R4 翻译覆盖(按 pairs)
  const pairedEn = new Set(pairs.map((p) => p.enBlockId));
  for (const b of enBlocks) {
    if (['figure', 'table', 'equation'].includes(b.type)) continue; // 整块裁图/重建,不走文字对
    if (!pairedEn.has(b.id)) {
      if (allowUnpaired.has(b.id)) {
        add('warn', b.id, `英文块 ${b.id}(${b.type}) 无译文配对(对齐结果为 1:0,待人工确认)`, 'R4');
      } else {
        add('error', b.id, `英文块 ${b.id}(${b.type}) 没有译文配对`, 'R4');
      }
    }
  }
  for (const p of pairs) {
    if (!p.zhText || !String(p.zhText).trim()) {
      add('error', p.enBlockId, `英文块 ${p.enBlockId} 的译文为空`, 'R4');
    }
  }

  // R5 行内公式标记数量(简化:两侧 $ 数量偏差 > 2 告警)
  const dollar = (s) => (String(s || '').match(/\$/g) || []).length;
  const enDollar = enBlocks.reduce((a, b) => a + dollar(b.text), 0);
  const zhDollar = zhBlocks.reduce((a, b) => a + dollar(b.text), 0) + pairs.reduce((a, p) => a + dollar(p.zhText), 0);
  if (Math.abs(enDollar - zhDollar) > 2) add('warn', undefined, `行内公式标记偏差:EN=${enDollar} ZH=${zhDollar}`, 'R5');

  // R6 术语缩写格式:带 abbr 的术语必须在译文中出现其缩写
  const zhAll = zhBlocks.map((b) => b.text || '').join('\n') + pairs.map((p) => p.zhText || '').join('\n');
  for (const t of terms) {
    if (t.abbr && !zhAll.includes(t.abbr)) {
      add('warn', undefined, `术语「${t.zh}」的缩写 ${t.abbr} 未在译文中出现(首次格式可能丢失)`, 'R6');
    }
  }

  // R7 译文污染
  for (const p of pairs) {
    const t = String(p.zhText || '');
    if (/翻译说明|译文说明|作为翻译|以下为译文|抱歉,我无法/i.test(t)) {
      add('error', p.enBlockId, `译文含说明性/拒译文本:${t.slice(0, 40)}`, 'R7');
    }
  }

  // R8 数字抽样一致性
  const enNums = new Set(enBlocks.flatMap((b) => extractNumbers(b.text)));
  const zhNums = new Set(zhBlocks.flatMap((b) => extractNumbers(b.text)).concat(pairs.flatMap((p) => extractNumbers(p.zhText))));
  const missingNums = [...enNums].filter((x) => !zhNums.has(x));
  if (missingNums.length) {
    add('warn', undefined, `英文数字在译文中缺失:[${missingNums.slice(0, 8).join(', ')}${missingNums.length > 8 ? '…' : ''}]`, 'R8');
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.filter((i) => i.severity === 'warn').length;
  return {
    issues,
    pass: errors === 0,
    errors,
    warns,
    report: { enLabels, zhLabels, enSec, zhSec, enDollar, zhDollar, missingNums },
  };
}

const __rootAudit = typeof globalThis !== 'undefined' ? globalThis : this;
__rootAudit.PaperParallelAudit = { runRuleAudit, extractSectionNumbers, extractNumberedLabels, extractNumbers };
