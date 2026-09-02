import type { ApiSettings, StoredApiSettings } from '../domain/types'

const SETTINGS_KEY = 'icrf.apiSettings'
const API_KEY = 'icrf.apiKey'

const defaults: ApiSettings = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash-vision-exp',
  apiKey: '',
}

const retiredModels = new Set(['deepseek-chat', 'deepseek-reasoner'])

function normalizeMetadata(value: Partial<ApiSettings>): Pick<ApiSettings, 'baseUrl' | 'model'> {
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : defaults.baseUrl
  const candidateModel = typeof value.model === 'string' ? value.model.trim() : defaults.model
  return {
    baseUrl: baseUrl || defaults.baseUrl,
    model: retiredModels.has(candidateModel) || !candidateModel ? defaults.model : candidateModel,
  }
}

export function saveApiSettings(settings: ApiSettings, persistKey: boolean): void {
  const metadata = normalizeMetadata(settings)
  const apiKey = settings.apiKey.trim()
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(metadata))
  sessionStorage.setItem(API_KEY, apiKey)
  if (persistKey) {
    localStorage.setItem(API_KEY, apiKey)
  } else {
    localStorage.removeItem(API_KEY)
  }
}

export function loadApiSettings(): StoredApiSettings {
  let metadata: Pick<ApiSettings, 'baseUrl' | 'model'> = defaults
  const raw = localStorage.getItem(SETTINGS_KEY)
  if (raw) {
    try {
      metadata = normalizeMetadata(JSON.parse(raw) as Partial<ApiSettings>)
    } catch {
      localStorage.removeItem(SETTINGS_KEY)
    }
  }
  const persistedKey = localStorage.getItem(API_KEY)
  return {
    ...metadata,
    apiKey: (sessionStorage.getItem(API_KEY) ?? persistedKey ?? '').trim(),
    persistKey: persistedKey !== null,
  }
}

export function clearApiKey(): void {
  sessionStorage.removeItem(API_KEY)
  localStorage.removeItem(API_KEY)
}
