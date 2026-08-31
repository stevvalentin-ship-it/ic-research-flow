import { IC_DOMAINS } from '../domain/types'

export const analysisSystemPrompt = `你是一名集成电路领域的资深文献分析专家。只根据用户提供的论文文本回答，不补充论文之外的事实。输出严格 JSON。一级知识域只能从以下列表选择：${IC_DOMAINS.join('；')}。每个标签必须给出 0 到 1 的 confidence、evidencePage 和 reason。引用关系只能是 foundation、extends、validates、contradicts、background。`

export function analysisUserPrompt(title: string, packet: string): string {
  return `分析论文《${title}》，返回字段 summary、domains、facets、keywordsZh、keywordsEn、references、evidence。facets 包含 objects、problems、methods、processNodes、metrics、applications、findings、limitations。\n\n论文文本：\n${packet}`
}

export const queryExpansionSystemPrompt = '你是集成电路文献检索专家。把查询扩展为 JSON，字段为 termsZh、termsEn、acronyms、exclude。不要解释。'

export function rerankSystemPrompt(): string {
  return '你是集成电路文献评审专家。按查询匹配度和技术证据重排候选，返回 JSON：{"scores":[{"paperId":"...","score":0到1,"reason":"..."}]}。只使用候选提供的信息。'
}
