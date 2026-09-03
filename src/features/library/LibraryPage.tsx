import { BookOpen, FileText, HardDrive, Network, RotateCcw, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PaperRecord } from '../../domain/types'
import { paperRepository } from '../../storage/paperRepository'
import { researchDatabase } from '../../storage/database'
import { loadApiSettings } from '../../storage/settingsStore'
import { parsePdf, renderPdfPageAsDataUrl } from '../../ingestion/pdfParser'
import { buildAnalysisPacket } from '../../ingestion/analysisPacket'
import { deepSeekClient } from '../../api/deepseekClient'
import { StatusBadge } from '../../components/StatusBadge'

function selectVisionPages(pageCount: number): number[] {
  const pages = new Set([1, pageCount])
  if (pageCount > 2) pages.add(Math.ceil(pageCount / 2))
  if (pageCount > 4) pages.add(Math.ceil(pageCount * 0.25))
  if (pageCount > 6) pages.add(Math.ceil(pageCount * 0.75))
  return Array.from(pages).sort((a, b) => a - b).slice(0, 4)
}

export function LibraryPage() {
  const [papers, setPapers] = useState<PaperRecord[]>([])
  const [query, setQuery] = useState('')
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const refresh = () => paperRepository.list().then(setPapers)
  useEffect(() => { void refresh() }, [])
  const visible = useMemo(() => papers.filter((paper) => `${paper.title} ${paper.authors.join(' ')}`.toLowerCase().includes(query.toLowerCase())), [papers, query])
  const bytes = papers.reduce((sum, paper) => sum + paper.fileSize, 0)
  const retryPaper = async (paper: PaperRecord) => {
    if (retryingId) return
    setRetryingId(paper.id); setError('')
    try {
      const settings = loadApiSettings()
      if (!settings.apiKey) throw new Error('请先回到首页连接 DeepSeek 后再重试')
      const file = new File([paper.blob], paper.fileName, { type: 'application/pdf' })
      const parsed = await parsePdf(file)
      const packet = buildAnalysisPacket(parsed)
      const images = parsed.isScanned
        ? await Promise.all(selectVisionPages(parsed.pageCount).map(async (page) => ({
            page,
            dataUrl: await renderPdfPageAsDataUrl(file, page, { scale: 1.5 }),
          })))
        : []
      const analysis = await deepSeekClient.analyzePaper({ paperId: paper.id, title: parsed.title, packet, images }, settings)
      await researchDatabase.analyses.put(analysis)
      await paperRepository.updateStatus(paper.id, 'completed')
      await researchDatabase.jobs.update(`job-${paper.id}`, { stage: 'completed', progress: 100, errorCode: undefined, errorMessage: undefined, updatedAt: Date.now() })
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '重试失败')
      await researchDatabase.jobs.update(`job-${paper.id}`, { stage: 'failed', errorCode: 'RETRY_FAILED', errorMessage: caught instanceof Error ? caught.message : '重试失败', updatedAt: Date.now() }).catch(() => undefined)
    } finally {
      setRetryingId(null)
    }
  }
  return (
    <div className="page-container library-page">
      <div className="page-title-row"><div><p className="eyebrow">LOCAL PAPER VAULT</p><h1>我的论文库</h1><p>所有内容均保存在当前浏览器中。</p></div><Link className="primary-button" to="/"><FileText size={16} />继续投入论文</Link></div>
      {error && <p className="error-text">{error}</p>}
      <div className="library-metrics"><div><BookOpen /><span><strong>{papers.length}</strong> 篇论文</span></div><div><HardDrive /><span><strong>{(bytes / 1024 / 1024).toFixed(1)}</strong> MB 本地占用</span></div><div><Network /><span><strong>{papers.filter((paper) => paper.analysisStatus === 'completed').length}</strong> 篇已入图</span></div></div>
      <section className="table-card">
        <div className="table-toolbar"><div className="field-search"><Search size={15} /><input aria-label="检索论文库" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按标题或作者过滤" /></div><span>{visible.length} RESULTS</span></div>
        {papers.length === 0 ? <div className="empty-library"><div><BookOpen size={30} /></div><h2>论文库还是空的</h2><p>导入第一批 PDF，DeepSeek 将提取方法、工艺节点、指标、结论和参考文献。</p><Link className="primary-button" to="/">投入论文</Link></div> : (
          <div className="paper-table"><div className="paper-row paper-header"><span>论文</span><span>年份</span><span>页数</span><span>分析状态</span><span /></div>{visible.map((paper) => <div className="paper-row" key={paper.id}><span><i className="pdf-tile">PDF</i><span><strong>{paper.title}</strong><small>{paper.authors.join(', ') || paper.fileName}</small></span></span><span>{paper.year ?? '—'}</span><span>{paper.pageCount}</span><span><StatusBadge status={paper.analysisStatus} /></span><span className="row-actions">{paper.analysisStatus === 'failed' && <button className="icon-button" disabled={retryingId === paper.id} onClick={() => void retryPaper(paper)} title="重试分析"><RotateCcw size={15} /></button>}<button aria-label={`删除 ${paper.title}`} onClick={async () => { await paperRepository.remove(paper.id); await refresh() }}><Trash2 size={16} /></button></span></div>)}</div>
        )}
      </section>
    </div>
  )
}
