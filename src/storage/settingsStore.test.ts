import { loadApiSettings, saveApiSettings } from './settingsStore'

describe('settingsStore', () => {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
  })

  it('keeps an API key in session storage unless persistence is explicit', () => {
    saveApiSettings(
      { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-test' },
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
