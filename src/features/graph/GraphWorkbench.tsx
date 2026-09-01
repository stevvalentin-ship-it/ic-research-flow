import { BookMarked, GitFork, ListFilter, Network, Trees } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { PaperAnalysis, PaperRecord, PaperScore } from '../../domain/types'
import { buildInfluenceGraph } from './graphModel'
import { InfluenceGraph } from './InfluenceGraph'
import { KnowledgeTree } from './KnowledgeTree'
import { PaperDetailPanel } from './PaperDetailPanel'

export function GraphWorkbench({ papers, analyses, scores }: { papers: PaperRecord[]; analyses: PaperAnalysis[]; scores: PaperScore[] }) {
  const [tab, setTab] = useState<'influence' | 'content' | 'papers'>('influence')
  const [selectedId, setSelectedId] = useState(papers[0]?.id)
  useEffect(() => {
    if (!papers.some((paper) => paper.id === selectedId)) setSelectedId(papers[0]?.id)
  }, [papers, selectedId])
  const graph = useMemo(() => buildInfluenceGraph(papers, analyses, scores), [papers, analyses, scores])
  const analysisById = new Map(analyses.map((analysis) => [analysis.paperId, analysis]))
  const scoreById = new Map(scores.map((score) => [score.paperId, score]))
  const selected = papers.find((paper) => paper.id === selectedId)
  return <div className="workbench-grid"><aside className="result-sidebar"><div className="result-heading"><span>CORE SET</span><strong>{papers.length}</strong><small>核心论文</small></div><div className="filter-caption"><ListFilter size={14} />价值排序</div><div className="core-list">{papers.map((paper, index) => <button key={paper.id} className={paper.id === selectedId ? 'active' : ''} onClick={() => setSelectedId(paper.id)}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{paper.title}</strong><small>{paper.year ?? '—'} · {scoreById.get(paper.id)?.role ?? 'foundation'}</small></div><em>{Math.round((scoreById.get(paper.id)?.total ?? 0) * 100)}</em></button>)}</div></aside><section className="graph-workspace"><div className="graph-tabs"><button className={tab === 'influence' ? 'active' : ''} onClick={() => setTab('influence')}><Network size={15} />影响力图谱</button><button className={tab === 'content' ? 'active' : ''} onClick={() => setTab('content')}><Trees size={15} />内容知识树</button><button className={tab === 'papers' ? 'active' : ''} onClick={() => setTab('papers')}><BookMarked size={15} />核心论文</button><span><GitFork size={14} />{graph.edges.length} 条引用关系</span></div>{tab === 'influence' && <InfluenceGraph nodes={graph.nodes} edges={graph.edges} selectedId={selectedId} onSelect={setSelectedId} />}{tab === 'content' && <KnowledgeTree papers={papers} analyses={analyses} onSelect={setSelectedId} />}{tab === 'papers' && <div className="paper-card-grid">{papers.map((paper) => <button key={paper.id} onClick={() => setSelectedId(paper.id)}><small>{scoreById.get(paper.id)?.role}</small><strong>{paper.title}</strong><span>{analysisById.get(paper.id)?.summary}</span></button>)}</div>}</section><PaperDetailPanel paper={selected} analysis={selected ? analysisById.get(selected.id) : undefined} score={selected ? scoreById.get(selected.id) : undefined} /></div>
}
