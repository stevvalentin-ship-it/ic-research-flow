import type { ApiSettings, StoredApiSettings } from '../domain/types'

const SETTINGS_KEY = 'icrf.apiSettings'
const API_KEY = 'icrf.apiKey'

const defaults: ApiSettings = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: '',
}

export function saveApiSettings(settings: ApiSettings, persistKey: boolean): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ baseUrl: settings.baseUrl, model: settings.model }))
  sessionStorage.setItem(API_KEY, settings.apiKey)
  if (persistKey) {
    localStorage.setItem(API_KEY, settings.apiKey)
  } else {
    localStorage.removeItem(API_KEY)
  }
}

export function loadApiSettings(): StoredApiSettings {
  let metadata: Pick<ApiSettings, 'baseUrl' | 'model'> = defaults
  const raw = localStorage.getItem(SETTINGS_KEY)
  if (raw) {
    try {
      metadata = { ...metadata, ...JSON.parse(raw) }
    } catch {
      localStorage.removeItem(SETTINGS_KEY)
    }
  }
  const persistedKey = localStorage.getItem(API_KEY)
  return {
    ...metadata,
    apiKey: sessionStorage.getItem(API_KEY) ?? persistedKey ?? '',
    persistKey: persistedKey !== null,
  }
}

export function clearApiKey(): void {
  sessionStorage.removeItem(API_KEY)
  localStorage.removeItem(API_KEY)
}
