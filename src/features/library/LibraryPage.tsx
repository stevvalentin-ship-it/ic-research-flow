import { BookOpen, FileText, HardDrive, Network, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PaperRecord } from '../../domain/types'
import { paperRepository } from '../../storage/paperRepository'
import { StatusBadge } from '../../components/StatusBadge'

export function LibraryPage() {
  const [papers, setPapers] = useState<PaperRecord[]>([])
  const [query, setQuery] = useState('')
  const refresh = () => paperRepository.list().then(setPapers)
  useEffect(() => { void refresh() }, [])
  const visible = useMemo(() => papers.filter((paper) => `${paper.title} ${paper.authors.join(' ')}`.toLowerCase().includes(query.toLowerCase())), [papers, query])
  const bytes = papers.reduce((sum, paper) => sum + paper.fileSize, 0)
  return (
    <div className="page-container library-page">
      <div className="page-title-row"><div><p className="eyebrow">LOCAL PAPER VAULT</p><h1>我的论文库</h1><p>所有内容均保存在当前浏览器中。</p></div><Link className="primary-button" to="/"><FileText size={16} />继续投入论文</Link></div>
      <div className="library-metrics"><div><BookOpen /><span><strong>{papers.length}</strong> 篇论文</span></div><div><HardDrive /><span><strong>{(bytes / 1024 / 1024).toFixed(1)}</strong> MB 本地占用</span></div><div><Network /><span><strong>{papers.filter((paper) => paper.analysisStatus === 'completed').length}</strong> 篇已入图</span></div></div>
      <section className="table-card">
        <div className="table-toolbar"><div className="field-search"><Search size={15} /><input aria-label="检索论文库" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按标题或作者过滤" /></div><span>{visible.length} RESULTS</span></div>
        {papers.length === 0 ? <div className="empty-library"><div><BookOpen size={30} /></div><h2>论文库还是空的</h2><p>导入第一批 PDF，DeepSeek 将提取方法、工艺节点、指标、结论和参考文献。</p><Link className="primary-button" to="/">投入论文</Link></div> : (
          <div className="paper-table"><div className="paper-row paper-header"><span>论文</span><span>年份</span><span>页数</span><span>分析状态</span><span /></div>{visible.map((paper) => <div className="paper-row" key={paper.id}><span><i className="pdf-tile">PDF</i><span><strong>{paper.title}</strong><small>{paper.authors.join(', ') || paper.fileName}</small></span></span><span>{paper.year ?? '—'}</span><span>{paper.pageCount}</span><span><StatusBadge status={paper.analysisStatus} /></span><button aria-label={`删除 ${paper.title}`} onClick={async () => { await paperRepository.remove(paper.id); await refresh() }}><Trash2 size={16} /></button></div>)}</div>
        )}
      </section>
    </div>
  )
}
