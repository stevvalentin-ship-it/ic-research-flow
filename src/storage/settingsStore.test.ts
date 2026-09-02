import { loadApiSettings, saveApiSettings } from './settingsStore'

describe('settingsStore', () => {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
  })

  it('uses the current DeepSeek model for a first-time visitor', () => {
    expect(loadApiSettings()).toMatchObject({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    })
  })

  it.each(['deepseek-chat', 'deepseek-reasoner', '  deepseek-chat  ', '\tdeepseek-reasoner\n'])('migrates the retired %s model', (model) => {
    localStorage.setItem('icrf.apiSettings', JSON.stringify({
      baseUrl: 'https://api.deepseek.com',
      model,
    }))

    expect(loadApiSettings().model).toBe('deepseek-v4-flash')
  })

  it('normalizes copied settings before storing them', () => {
    saveApiSettings(
      { baseUrl: '  https://api.deepseek.com/v1  ', model: ' deepseek-v4-pro ', apiKey: '  sk-test\n' },
      false,
    )

    expect(loadApiSettings()).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
      apiKey: 'sk-test',
      persistKey: false,
    })
  })

  it('keeps an API key in session storage unless persistence is explicit', () => {
    saveApiSettings(
      { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: 'sk-test' },
      false,
    )

    expect(sessionStorage.getItem('icrf.apiKey')).toBe('sk-test')
    expect(localStorage.getItem('icrf.apiKey')).toBeNull()
  })

  it('loads a persisted key only when the session key is absent', () => {
    saveApiSettings(
      { baseUrl: 'https://example.com', model: 'research-model', apiKey: 'persisted' },
      true,
    )
    sessionStorage.clear()

    expect(loadApiSettings()).toEqual({
      baseUrl: 'https://example.com',
      model: 'research-model',
      apiKey: 'persisted',
      persistKey: true,
    })
  })
})
