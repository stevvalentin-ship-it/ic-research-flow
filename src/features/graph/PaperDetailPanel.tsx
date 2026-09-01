import { BookOpenCheck, ExternalLink, FileText, Gauge, Sparkles } from 'lucide-react'
import type { PaperAnalysis, PaperRecord, PaperScore } from '../../domain/types'

const labels: Array<[keyof Pick<PaperScore, 'relevance' | 'influence' | 'frontier' | 'evidence' | 'bridge'>, string]> = [['relevance', '主题相关'], ['influence', '网络影响'], ['frontier', '前沿程度'], ['evidence', '证据质量'], ['bridge', '跨域桥接']]

export function PaperDetailPanel({ paper, analysis, score }: { paper?: PaperRecord; analysis?: PaperAnalysis; score?: PaperScore }) {
  if (!paper || !score) return <aside className="detail-panel empty-detail"><Gauge size={28} /><p>选择图中节点查看评分、摘要与证据页。</p></aside>
  const openPdf = () => {
    if (!paper.blob?.size) return
    const url = URL.createObjectURL(paper.blob)
    window.open(url, '_blank', 'noopener,noreferrer')
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
  return <aside className="detail-panel"><div className="detail-kicker"><span>{score.role.toUpperCase()}</span><small>#{paper.id.slice(0, 6)}</small></div><h2>{paper.title}</h2><p className="paper-meta">{paper.authors.join(', ') || '本地论文'} · {paper.year ?? '年份未知'}</p><div className="total-score"><div><span>综合得分</span><strong>{(score.total * 100).toFixed(1)}</strong></div><Sparkles size={21} /></div><div className="score-breakdown">{labels.map(([key, label]) => <div key={key}><span>{label}</span><i><b style={{ width: `${score[key] * 100}%` }} /></i><strong>{Math.round(score[key] * 100)}</strong></div>)}</div><section className="detail-section"><h3><BookOpenCheck size={15} />为什么值得精读</h3><p>{score.reason || analysis?.summary || '在当前检索问题中兼具主题相关性与网络影响力。'}</p></section>{analysis?.evidence?.slice(0, 2).map((evidence) => <blockquote key={`${evidence.page}-${evidence.label}`}><span><FileText size={14} />PAGE {evidence.page} · {evidence.label}</span><p>“{evidence.quote}”</p></blockquote>)}<button className="secondary-button detail-open" disabled={!paper.blob?.size} onClick={openPdf}>{paper.blob?.size ? '打开本地 PDF' : '示例论文无本地文件'} <ExternalLink size={15} /></button></aside>
}
