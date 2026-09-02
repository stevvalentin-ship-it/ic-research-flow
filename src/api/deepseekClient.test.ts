import { DeepSeekClient } from './deepseekClient'
import type { ApiSettings } from '../domain/types'

const settings: ApiSettings = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  apiKey: 'sk-test',
}

function jsonResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-v4-flash',
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

    expect(result).toEqual({ ok: true, model: 'deepseek-v4-flash' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-test')
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'deepseek-v4-flash', max_tokens: 8 })
  })

  it('sends page images to the vision model for scanned PDFs', async () => {
    const analysisJson = JSON.stringify({
      summary: 'test',
      domains: [],
      facets: { objects: [], problems: [], methods: [], processNodes: [], metrics: [], applications: [], findings: [], limitations: [] },
      keywordsZh: [],
      keywordsEn: [],
      references: [],
      evidence: [],
    })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(analysisJson))
    const client = new DeepSeekClient(fetchImpl)

    await client.analyzePaper({
      paperId: 'paper-1',
      title: 'A scanned paper',
      packet: '',
      images: [{ page: 1, dataUrl: 'data:image/jpeg;base64,abc' }],
    }, settings)

    const [, init] = fetchImpl.mock.calls[0]
    const body = JSON.parse(String(init?.body))
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: expect.any(String) },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc', detail: 'high' } },
    ])
  })

  it('calls fetch as a plain function so native fetch keeps its browser this-binding', async () => {
    const fetchImpl = vi.fn(function (this: unknown) {
      expect(this).toBeUndefined()
      return Promise.resolve(jsonResponse('{"ok":true}'))
    }) as unknown as typeof fetch
    const client = new DeepSeekClient(fetchImpl)

    await expect(client.testConnection(settings)).resolves.toEqual({ ok: true, model: 'deepseek-v4-flash' })
  })

  it.each([
    ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://api.deepseek.com/chat/completions', 'https://api.deepseek.com/chat/completions'],
    ['https://api.deepseek.com/v1/chat/completions/', 'https://api.deepseek.com/v1/chat/completions'],
  ])('normalizes API address %s', async (baseUrl, expectedEndpoint) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse('{"ok":true}'))
    const client = new DeepSeekClient(fetchImpl)

    await client.testConnection({ ...settings, baseUrl })

    expect(fetchImpl.mock.calls[0][0]).toBe(expectedEndpoint)
  })

  it.each(['', '/api/proxy', 'javascript:alert(1)', 'http://api.example.com'])('rejects the unsafe API address %j before sending the key', async (baseUrl) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse('{"ok":true}'))
    const client = new DeepSeekClient(fetchImpl)

    await expect(client.testConnection({ ...settings, baseUrl })).rejects.toMatchObject({
      code: 'INVALID_ENDPOINT',
      message: 'API 地址必须是 HTTPS 完整地址；仅本机接口允许 HTTP。',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('allows an HTTP endpoint on the local machine', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse('{"ok":true}'))
    const client = new DeepSeekClient(fetchImpl)

    await client.testConnection({ ...settings, baseUrl: 'http://127.0.0.1:8000/v1' })

    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:8000/v1/chat/completions')
  })

  it('routes the official API through the same-origin development proxy when enabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse('{"ok":true}'))
    const client = new DeepSeekClient(fetchImpl, { useOfficialDevProxy: true })

    await client.testConnection(settings)

    expect(fetchImpl.mock.calls[0][0]).toBe('/__deepseek_api__/chat/completions')
  })

  it.each([
    ['an unrelated JSON response', new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['a null JSON response', new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['a non-JSON response', new Response('<html>not an API</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })],
  ])('rejects %s instead of reporting a false connection', async (_label, response) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
    const client = new DeepSeekClient(fetchImpl)

    await expect(client.testConnection(settings)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: 'DeepSeek 返回格式无效，请检查 API 地址后重试。',
    })
  })

  it('accepts a valid chat-completion envelope even when the short probe has empty content', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'length' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = new DeepSeekClient(fetchImpl)

    await expect(client.testConnection(settings)).resolves.toEqual({ ok: true, model: 'deepseek-v4-flash' })
  })

  it('maps authentication failures to a stable error code', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const client = new DeepSeekClient(fetchImpl)

    await expect(client.testConnection(settings)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      message: 'API Key 无效或无权访问，请检查后重试。',
    })
  })

  it('explains an obsolete or invalid model response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'Model Not Exist' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ))
    const client = new DeepSeekClient(fetchImpl)

    await expect(client.testConnection(settings)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: '请求参数无效，请检查模型名称和 API 地址。',
    })
  })

  it('distinguishes an account with insufficient balance', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('insufficient balance', { status: 402 }))
    const client = new DeepSeekClient(fetchImpl)

    await expect(client.testConnection(settings)).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      message: 'DeepSeek 账户余额不足，请充值后重试。',
    })
  })

  it.each([
    [404, 'MODEL_OR_ENDPOINT_NOT_FOUND', '未找到模型或接口，请检查模型名称和 API 地址。'],
    [429, 'RATE_LIMITED', '请求过于频繁，请稍后再试。'],
    [500, 'SERVER_UNAVAILABLE', 'DeepSeek 服务暂时不可用，请稍后再试。'],
    [503, 'SERVER_UNAVAILABLE', 'DeepSeek 服务暂时不可用，请稍后再试。'],
  ])('maps HTTP %i to %s', async (status, code, message) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('request failed', { status }))
    const client = new DeepSeekClient(fetchImpl)

    await expect(client.testConnection(settings)).rejects.toMatchObject({ code, message, status })
  })

  it('turns a browser network or CORS failure into actionable guidance', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'))
    const client = new DeepSeekClient(fetchImpl)

    await expect(client.testConnection(settings)).rejects.toMatchObject({
      code: 'NETWORK_FAILED',
      message: '无法访问 API 地址，请检查网络、地址以及接口是否允许当前网页跨域访问。',
    })
  })

  it('ignores whitespace accidentally copied around the key and model', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse('{"ok":true}'))
    const client = new DeepSeekClient(fetchImpl)

    await client.testConnection({ ...settings, apiKey: '  sk-test\n', model: ' deepseek-v4-flash ' })

    const [, init] = fetchImpl.mock.calls[0]
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-test')
    expect(JSON.parse(String(init?.body)).model).toBe('deepseek-v4-flash')
  })

  it('keeps the short probe limit out of paper analysis and still requires analysis content', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(''))
    const client = new DeepSeekClient(fetchImpl)

    await expect(client.analyzePaper({ paperId: 'paper-1', title: 'A paper', packet: 'Abstract text' }, settings))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE', message: 'DeepSeek 返回内容为空，请重试。' })

    const [, init] = fetchImpl.mock.calls[0]
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('max_tokens')
  })
})
