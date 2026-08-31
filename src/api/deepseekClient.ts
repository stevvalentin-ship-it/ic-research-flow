import type { ApiSettings, PaperAnalysis } from '../domain/types'
import { extractJsonObject, normalizePaperAnalysis } from './analysisSchema'
import { analysisSystemPrompt, analysisUserPrompt, queryExpansionSystemPrompt, rerankSystemPrompt } from './prompts'

interface ChatMessage { role: 'system' | 'user'; content: string }
interface ChatResponse {
  model?: string
  choices?: Array<{ message?: { content?: string } }>
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

function mapStatus(status: number): string {
  if (status === 401 || status === 403) return 'AUTH_FAILED'
  if (status === 429) return 'RATE_LIMITED'
  if (status === 404) return 'MODEL_OR_ENDPOINT_NOT_FOUND'
  return 'API_REQUEST_FAILED'
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export class DeepSeekClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async chat(settings: ApiSettings, messages: ChatMessage[]): Promise<{ content: string; model: string }> {
    const endpoint = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`
    let response: Response
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({ model: settings.model, messages, stream: false }),
      })
    } catch (error) {
      throw new DeepSeekError('NETWORK_FAILED', error instanceof Error ? error.message : 'Network request failed')
    }
    if (!response.ok) {
      throw new DeepSeekError(mapStatus(response.status), `DeepSeek request failed with ${response.status}`, response.status)
    }
    const payload = await response.json() as ChatResponse
    const content = payload.choices?.[0]?.message?.content
    if (!content) throw new DeepSeekError('INVALID_RESPONSE', 'DeepSeek response did not include content')
    return { content, model: payload.model ?? settings.model }
  }

  async testConnection(settings: ApiSettings): Promise<ConnectionResult> {
    const result = await this.chat(settings, [
      { role: 'system', content: 'Return only {"ok":true}.' },
      { role: 'user', content: 'connection test' },
    ])
    return { ok: true, model: result.model }
  }

  async analyzePaper(input: { paperId: string; title: string; packet: string }, settings: ApiSettings): Promise<PaperAnalysis> {
    const result = await this.chat(settings, [
      { role: 'system', content: analysisSystemPrompt },
      { role: 'user', content: analysisUserPrompt(input.title, input.packet) },
    ])
    return normalizePaperAnalysis(input.paperId, extractJsonObject(result.content))
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

export const deepSeekClient = new DeepSeekClient()
