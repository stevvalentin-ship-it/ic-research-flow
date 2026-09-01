import { Check, Eye, EyeOff, KeyRound, LoaderCircle, PlugZap, Server } from 'lucide-react'
import { useState } from 'react'
import type { ApiSettings } from '../../domain/types'
import { deepSeekClient } from '../../api/deepseekClient'
import { loadApiSettings, saveApiSettings } from '../../storage/settingsStore'

export function ApiSettingsForm({ onConnectionChange }: { onConnectionChange: (valid: boolean, settings: ApiSettings) => void }) {
  const stored = loadApiSettings()
  const [settings, setSettings] = useState<ApiSettings>({ baseUrl: stored.baseUrl, model: stored.model, apiKey: stored.apiKey })
  const [persist, setPersist] = useState(stored.persistKey)
  const [showKey, setShowKey] = useState(false)
  const [state, setState] = useState<'idle' | 'testing' | 'connected' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const update = (field: keyof ApiSettings, value: string) => {
    const next = { ...settings, [field]: value }
    setSettings(next); setState('idle'); onConnectionChange(false, next)
  }
  const test = async () => {
    setState('testing'); setMessage('')
    try {
      const result = await deepSeekClient.testConnection(settings)
      saveApiSettings(settings, persist)
      setState('connected'); setMessage(`已连接 ${result.model}`); onConnectionChange(true, settings)
    } catch (error) {
      setState('error'); setMessage(error instanceof Error ? error.message : '连接失败'); onConnectionChange(false, settings)
    }
  }
  return (
    <section className="setup-card api-card">
      <div className="card-heading">
        <span className="step-number">02</span>
        <div><p className="eyebrow">DEEPSEEK CONNECTION</p><h2>连接 DeepSeek</h2></div>
        <span className={`connection-dot ${state}`}><i />{state === 'connected' ? '已连接' : '未连接'}</span>
      </div>
      <div className="form-grid">
        <label><span><Server size={14} />API 地址</span><input value={settings.baseUrl} onChange={(event) => update('baseUrl', event.target.value)} /></label>
        <label><span><PlugZap size={14} />模型</span><input value={settings.model} onChange={(event) => update('model', event.target.value)} /></label>
        <label className="full-field"><span><KeyRound size={14} />API Key</span><div className="key-input"><input aria-label="API Key" type={showKey ? 'text' : 'password'} value={settings.apiKey} placeholder="sk-••••••••••••••••" onChange={(event) => update('apiKey', event.target.value)} /><button type="button" aria-label="显示密钥" onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
      </div>
      <div className="api-actions">
        <label className="check-row"><input aria-label="在本机保存 Key" type="checkbox" checked={persist} onChange={(event) => setPersist(event.target.checked)} /><span>在本机保存 Key</span></label>
        <button type="button" className="secondary-button" disabled={!settings.apiKey || state === 'testing'} onClick={test}>
          {state === 'testing' ? <LoaderCircle className="spin" size={16} /> : state === 'connected' ? <Check size={16} /> : <PlugZap size={16} />}测试连接
        </button>
      </div>
      {persist && <p className="security-note">密钥仅保存在当前浏览器的本地存储中；共享设备不建议勾选。</p>}
      {message && <p className={`connection-message ${state}`}>{message}</p>}
    </section>
  )
}
