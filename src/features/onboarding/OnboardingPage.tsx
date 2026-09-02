import { ArrowRight, BookMarked, BrainCircuit, Database, FileCheck2, LockKeyhole, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ApiSettings, PaperRecord } from '../../domain/types'
import { FileDropzone } from '../../components/FileDropzone'
import { ApiSettingsForm } from '../settings/ApiSettingsForm'
import { fingerprintFile } from '../../ingestion/fileFingerprint'
import { parsePdf } from '../../ingestion/pdfParser'
import { buildAnalysisPacket } from '../../ingestion/analysisPacket'
import { paperRepository } from '../../storage/paperRepository'
import { researchDatabase } from '../../storage/database'
import { deepSeekClient } from '../../api/deepseekClient'

export function OnboardingPage() {
  const navigate = useNavigate()
  const [files, setFiles] = useState<File[]>([])
  const [connected, setConnected] = useState(false)
  const [settings, setSettings] = useState<ApiSettings>({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: '' })
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, label: '' })
  const [error, setError] = useState('')
  const buildLibrary = async () => {
    setRunning(true); setError('')
    let activePaperId = ''
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        setProgress({ done: index, label: `正在解析 ${file.name}` })
        const id = await fingerprintFile(file)
        activePaperId = id
        await researchDatabase.jobs.put({ id: `job-${id}`, paperId: id, stage: 'parsing', progress: 8, attempts: 0, updatedAt: Date.now() })
        const parsed = await parsePdf(file)
        const now = Date.now()
        const record: PaperRecord = {
          id, fileName: file.name, fileSize: file.size, blob: file, pageCount: parsed.pageCount,
          createdAt: now, updatedAt: now, title: parsed.title, authors: [], fullText: parsed.fullText,
          pageTexts: parsed.pageTexts, analysisStatus: 'analyzing', analysisVersion: 1,
        }
        await paperRepository.put(record)
        await researchDatabase.jobs.update(`job-${id}`, { stage: 'analyzing', progress: 42, updatedAt: Date.now() })
        setProgress({ done: index, label: `DeepSeek 正在理解 ${file.name}` })
        const analysis = await deepSeekClient.analyzePaper({ paperId: id, title: parsed.title, packet: buildAnalysisPacket(parsed) }, settings)
        await researchDatabase.jobs.update(`job-${id}`, { stage: 'indexing', progress: 84, updatedAt: Date.now() })
        await researchDatabase.analyses.put(analysis)
        await paperRepository.updateStatus(id, 'completed')
        await researchDatabase.jobs.update(`job-${id}`, { stage: 'completed', progress: 100, updatedAt: Date.now() })
        setProgress({ done: index + 1, label: `${file.name} 已完成` })
        activePaperId = ''
      }
      navigate('/library')
    } catch (caught) {
      if (activePaperId) {
        await researchDatabase.jobs.update(`job-${activePaperId}`, { stage: 'failed', errorCode: 'PROCESSING_FAILED', errorMessage: caught instanceof Error ? caught.message : '处理失败', updatedAt: Date.now() })
        await paperRepository.updateStatus(activePaperId, 'failed').catch(() => undefined)
      }
      setError(caught instanceof Error ? caught.message : '处理失败，请检查文件与 API 连接。')
    } finally { setRunning(false) }
  }
  return (
    <div className="onboarding-page">
      <section className="hero-section">
        <div className="hero-copy">
          <p className="eyebrow"><span />LOCAL-FIRST ACADEMIC INTELLIGENCE</p>
          <h1>投入集成电路论文<br /><em>构建你的科研知识流</em></h1>
          <p className="hero-description">从本地 PDF 中抽取知识、建立内容分类与引用网络，再用 IC-Influence Rank 找出真正值得精读的核心论文。</p>
          <div className="hero-chips"><span><LockKeyhole size={14} />论文留在本机</span><span><BrainCircuit size={14} />DeepSeek 语义理解</span><span><Sparkles size={14} />核心论文自动筛选</span></div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="chip-core"><BrainCircuit size={31} /><small>IC KNOWLEDGE</small></div>
          {['器件工艺', '电路架构', 'EDA 验证', '先进封装'].map((label, index) => <span key={label} className={`orbit-label orbit-label-${index}`}>{label}</span>)}
        </div>
      </section>
      <section className="metric-strip">
        <div><Database /><strong>100%</strong><span>浏览器本地存储</span></div>
        <div><BookMarked /><strong>50</strong><span>最多候选论文</span></div>
        <div><FileCheck2 /><strong>12–15</strong><span>核心精读论文</span></div>
        <div><BrainCircuit /><strong>9</strong><span>集成电路知识域</span></div>
      </section>
      <div className="setup-layout">
        <section className="setup-card upload-card">
          <div className="card-heading"><span className="step-number">01</span><div><p className="eyebrow">LOCAL PAPER VAULT</p><h2>导入本地论文库</h2></div><span className="card-meta">PDF · MULTI SELECT</span></div>
          <FileDropzone files={files} onFiles={setFiles} />
          <div className="privacy-row"><LockKeyhole size={15} /><span><strong>隐私边界：</strong>原始 PDF 留在 IndexedDB；仅为分析选取的文本片段会发送到你配置的 DeepSeek 接口。</span></div>
        </section>
        <ApiSettingsForm onConnectionChange={(valid, next) => { setConnected(valid); setSettings(next) }} />
      </div>
      <section className="build-bar">
        <div><span className="build-state"><i className={connected && files.length ? 'ready' : ''} />{running ? progress.label : connected && files.length ? `已就绪：${files.length} 篇论文` : '等待论文与有效 API 连接'}</span>{running && <progress value={progress.done} max={files.length} />}{error && <small className="error-text">{error}</small>}</div>
        <button type="button" className="primary-button" disabled={!files.length || !connected || running} onClick={buildLibrary}>开始构建论文库<ArrowRight size={17} /></button>
      </section>
    </div>
  )
}
