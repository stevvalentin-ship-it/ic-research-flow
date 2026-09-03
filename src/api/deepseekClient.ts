import type { ApiSettings, PaperAnalysis } from '../domain/types'
import { extractJsonObject, normalizePaperAnalysis } from './analysisSchema'
import { analysisSystemPrompt, analysisUserPrompt, queryExpansionSystemPrompt, rerankSystemPrompt } from './prompts'

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'original' | 'high' | 'low' } }

interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }
interface ChatResponse {
  model?: string
  choices?: Array<{ message?: { content?: string | null } }>
}

interface ChatOptions {
  maxTokens?: number
  requireContent?: boolean
  timeoutMs?: number
}

interface DeepSeekClientOptions {
  useOfficialDevProxy?: boolean
}

export interface ConnectionResult { ok: true; model: string }
export interface QueryExpansion { termsZh: string[]; termsEn: string[]; acronyms: string[]; exclude: string[] }
export interface RerankCandidate { paperId: string; title: string; summary: string; domains: string[] }
export interface RerankScore { paperId: string; score: number; reason: string }

export class DeepSeekError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message)
    this.name = 'DeepSeekError'
  }
}

function mapStatus(status: number): { code: string; message: string } {
  if (status === 400 || status === 422) {
    return { code: 'INVALID_REQUEST', message: '请求参数无效，请检查模型名称和 API 地址。' }
  }
  if (status === 401 || status === 403) {
    return { code: 'AUTH_FAILED', message: 'API Key 无效或无权访问，请检查后重试。' }
  }
  if (status === 402) {
    return { code: 'INSUFFICIENT_BALANCE', message: 'DeepSeek 账户余额不足，请充值后重试。' }
  }
  if (status === 404) {
    return { code: 'MODEL_OR_ENDPOINT_NOT_FOUND', message: '未找到模型或接口，请检查模型名称和 API 地址。' }
  }
  if (status === 429) {
    return { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试。' }
  }
  if (status === 500 || status === 503) {
    return { code: 'SERVER_UNAVAILABLE', message: 'DeepSeek 服务暂时不可用，请稍后再试。' }
  }
  return { code: 'API_REQUEST_FAILED', message: `DeepSeek 请求失败（HTTP ${status}）。` }
}

function chatEndpoint(baseUrl: string): string {
  let endpoint: URL
  try {
    endpoint = new URL(baseUrl.trim())
  } catch {
    throw new DeepSeekError('INVALID_ENDPOINT', 'API 地址必须是 HTTPS 完整地址；仅本机接口允许 HTTP。')
  }
  const isLocal = endpoint.hostname === 'localhost'
    || endpoint.hostname.endsWith('.localhost')
    || endpoint.hostname === '127.0.0.1'
    || endpoint.hostname === '[::1]'
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && isLocal)) {
    throw new DeepSeekError('INVALID_ENDPOINT', 'API 地址必须是 HTTPS 完整地址；仅本机接口允许 HTTP。')
  }
  const normalizedPath = endpoint.pathname.replace(/\/+$/, '')
  endpoint.pathname = /\/chat\/completions$/i.test(normalizedPath)
    ? normalizedPath
    : `${normalizedPath}/chat/completions`
  endpoint.hash = ''
  return endpoint.toString()
}

function runtimeEndpoint(endpoint: string, useOfficialDevProxy: boolean): string {
  const parsed = new URL(endpoint)
  return useOfficialDevProxy && parsed.origin === 'https://api.deepseek.com'
    ? `/__deepseek_api__${parsed.pathname}${parsed.search}`
    : endpoint
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export class DeepSeekClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: DeepSeekClientOptions = {},
  ) {}

  private async chat(settings: ApiSettings, messages: ChatMessage[], options: ChatOptions = {}): Promise<{ content: string; model: string }> {
    const endpoint = runtimeEndpoint(chatEndpoint(settings.baseUrl), this.options.useOfficialDevProxy === true)
    const model = settings.model.trim()
    const body: Record<string, unknown> = { model, messages, stream: false }
    if (options.maxTokens) body.max_tokens = options.maxTokens
    let response: Response
    const fetchImpl = this.fetchImpl
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? 90_000
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey.trim()}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DeepSeekError('REQUEST_TIMEOUT', 'DeepSeek 请求超时，请检查网络后重试。')
      }
      throw new DeepSeekError(
        'NETWORK_FAILED',
        '无法访问 API 地址，请检查网络、地址以及接口是否允许当前网页跨域访问。',
      )
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) {
      const mapped = mapStatus(response.status)
      throw new DeepSeekError(mapped.code, mapped.message, response.status)
    }
    let payload: ChatResponse
    try {
      payload = await response.json() as ChatResponse
    } catch {
      throw new DeepSeekError('INVALID_RESPONSE', 'DeepSeek 返回格式无效，请检查 API 地址后重试。')
    }
    const message = payload && typeof payload === 'object' ? payload.choices?.[0]?.message : undefined
    if (!message) {
      throw new DeepSeekError('INVALID_RESPONSE', 'DeepSeek 返回格式无效，请检查 API 地址后重试。')
    }
    const content = typeof message.content === 'string' ? message.content : ''
    if (options.requireContent !== false && !content) {
      throw new DeepSeekError('INVALID_RESPONSE', 'DeepSeek 返回内容为空，请重试。')
    }
    return { content, model: payload.model ?? model }
  }

  async testConnection(settings: ApiSettings): Promise<ConnectionResult> {
    const result = await this.chat(settings, [
      { role: 'system', content: 'Return only {"ok":true}.' },
      { role: 'user', content: 'connection test' },
    ], { maxTokens: 8, requireContent: false })
    return { ok: true, model: result.model }
  }

  async analyzePaper(input: {
    paperId: string
    title: string
    packet: string
    images?: Array<{ page: number; dataUrl: string }>
  }, settings: ApiSettings): Promise<PaperAnalysis> {
    const buildUserContent = (retry: boolean): ChatMessage['content'] => {
      const base = retry
        ? `${analysisUserPrompt(input.title, input.packet)} 上一次输出不是严格 JSON。请只输出一个 JSON 对象，不要 Markdown 代码块，不要解释，不要额外文字。`
        : `${analysisUserPrompt(input.title, input.packet)} 若论文文本为空，请根据附带的页面图片识别内容，并严格按相同 JSON 结构输出。`
      if (!input.images?.length) return base
      return [
        { type: 'text' as const, text: base },
        ...input.images.map((image) => ({
          type: 'image_url' as const,
          image_url: { url: image.dataUrl, detail: 'high' as const },
        })),
      ]
    }
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await this.chat(settings, [
          { role: 'system', content: attempt === 0 ? analysisSystemPrompt : `${analysisSystemPrompt} 必须只输出一个 JSON 对象，严禁输出解释、Markdown 或前缀。` },
          { role: 'user', content: buildUserContent(attempt > 0) },
        ])
        return normalizePaperAnalysis(input.paperId, extractJsonObject(result.content))
      } catch (error) {
        lastError = error
        const retryable = error instanceof Error
          && (/MODEL_JSON|INVALID_RESPONSE|DeepSeek 返回内容为空|JSON/.test(error.message))
        if (!retryable || attempt >= 2) throw error
      }
    }
    throw lastError
  }

  async expandQuery(query: string, settings: ApiSettings): Promise<QueryExpansion> {
    const result = await this.chat(settings, [
      { role: 'system', content: queryExpansionSystemPrompt },
      { role: 'user', content: query },
    ])
    const parsed = extractJsonObject(result.content)
    return {
      termsZh: stringList(parsed.termsZh),
      termsEn: stringList(parsed.termsEn),
      acronyms: stringList(parsed.acronyms),
      exclude: stringList(parsed.exclude),
    }
  }

  async rerankCandidates(query: string, candidates: RerankCandidate[], settings: ApiSettings): Promise<RerankScore[]> {
    const result = await this.chat(settings, [
      { role: 'system', content: rerankSystemPrompt() },
      { role: 'user', content: JSON.stringify({ query, candidates }) },
    ])
    const parsed = extractJsonObject(result.content)
    return (Array.isArray(parsed.scores) ? parsed.scores : []).map((item) => {
      const score = item as Record<string, unknown>
      return {
        paperId: String(score.paperId ?? ''),
        score: Math.min(1, Math.max(0, Number(score.score) || 0)),
        reason: String(score.reason ?? ''),
      }
    }).filter((score) => score.paperId)
  }
}

function isLocalPage(): boolean {
  if (typeof window === 'undefined') return false
  const hostname = window.location.hostname
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
}

export const deepSeekClient = new DeepSeekClient(fetch, {
  useOfficialDevProxy: import.meta.env.DEV || isLocalPage(),
})
