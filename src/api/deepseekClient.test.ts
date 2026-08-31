import { DeepSeekClient } from './deepseekClient'
import type { ApiSettings } from '../domain/types'

const settings: ApiSettings = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-test',
}

function jsonResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('DeepSeekClient', () => {
  it('sends an OpenAI-compatible authenticated connection test', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse('{"ok":true}'))
    const client = new DeepSeekClient(fetchImpl)

    const result = await client.testConnection(settings)

    expect(result).toEqual({ ok: true, model: 'deepseek-chat' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-test')
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'deepseek-chat' })
  })

  it('maps authentication failures to a stable error code', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const client = new DeepSeekClient(fetchImpl)

    await expect(client.testConnection(settings)).rejects.toMatchObject({ code: 'AUTH_FAILED' })
  })
})
