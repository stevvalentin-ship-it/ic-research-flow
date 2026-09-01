import { ArrowRight, BrainCircuit, ChevronDown, Filter, Search, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PaperAnalysis, PaperRecord, PaperScore } from '../../domain/types'
import { paperRepository } from '../../storage/paperRepository'
import { researchDatabase } from '../../storage/database'
import { LocalPaperIndex } from '../../search/localSearch'
import { retrieveCandidates } from '../../search/retrievalPipeline'
import { personalizedPageRank } from '../../influence/pageRank'
import { scorePaper } from '../../influence/scoring'
import { selectDiverseCorePapers } from '../../influence/mmr'
import { matchLocalReferences } from '../../influence/referenceMatcher'
import { GraphWorkbench } from '../graph/GraphWorkbench'
import { demoAnalyses, demoPapers, demoScores } from './demoData'

export function SearchPage() {
  const [query, setQuery] = useState('Chiplet 热管理与 die-to-die 互连协同优化')
  const [papers, setPapers] = useState<PaperRecord[]>(demoPapers)
  const [analyses, setAnalyses] = useState<PaperAnalysis[]>(demoAnalyses)
  const [scores, setScores] = useState<PaperScore[]>(demoScores)
  const [candidateCount, setCandidateCount] = useState(50)
  const [demoMode, setDemoMode] = useState(true)
  const [running, setRunning] = useState(false)
  useEffect(() => {
    void Promise.all([paperRepository.list(), researchDatabase.analyses.toArray()]).then(([storedPapers, storedAnalyses]) => {
      if (storedPapers.length) {
        const initialPapers = storedPapers.slice(0, 15)
        setPapers(initialPapers); setAnalyses(matchLocalReferences(storedPapers, storedAnalyses));
        setScores(initialPapers.map((paper, index) => ({ paperId: paper.id, relevance: .75, influence: .55, frontier: paper.year ? Math.max(.25, 1 - (new Date().getFullYear() - paper.year) / 15) : .5, evidence: .65, bridge: .45, total: .64 - index * .01, role: index < 3 ? 'foundation' : index > 10 ? 'frontier' : 'hub', reason: '运行检索后将刷新为针对当前问题的五维评分。' })))
        setDemoMode(false); setCandidateCount(storedPapers.length)
      }
    })
  }, [])
  const run = async () => {
    setRunning(true)
    const allPapers = await paperRepository.list()
    const allAnalyses = matchLocalReferences(allPapers, await researchDatabase.analyses.toArray())
    if (!allPapers.length) { setPapers(demoPapers); setAnalyses(demoAnalyses); setScores(demoScores); setDemoMode(true); setCandidateCount(50); setRunning(false); return }
    const results = await retrieveCandidates(new LocalPaperIndex(allPapers, allAnalyses), query, undefined, 50)
    const candidates = results.length ? results : allPapers.slice(0, 50).map((paper, index) => ({ id: paper.id, score: 1 - index / 50, terms: [] }))
    setCandidateCount(candidates.length)
    const candidatePapers = candidates.map((item) => allPapers.find((paper) => paper.id === item.id)!).filter(Boolean)
    const candidateIds = new Set(candidatePapers.map((paper) => paper.id))
    const candidateAnalyses = allAnalyses.filter((analysis) => candidateIds.has(analysis.paperId))
    const maxRelevance = Math.max(...candidates.map((item) => item.score), 1)
    const personalization = Object.fromEntries(candidates.map((item) => [item.id, item.score / maxRelevance]))
    const rank = personalizedPageRank({ nodes: [...candidateIds], edges: candidateAnalyses.flatMap((analysis) => analysis.references.filter((reference) => reference.matchedPaperId && candidateIds.has(reference.matchedPaperId)).map((reference) => ({ source: analysis.paperId, target: reference.matchedPaperId!, relation: reference.relation }))), years: Object.fromEntries(candidatePapers.map((paper) => [paper.id, paper.year])) }, personalization)
    const generated = candidatePapers.map((paper) => {
      const relevance = personalization[paper.id] ?? 0
      const influence = rank[paper.id] / Math.max(...Object.values(rank), 0.0001)
      const frontier = paper.year ? Math.max(0.2, 1 - (new Date().getFullYear() - paper.year) / 15) : 0.5
      const analysis = candidateAnalyses.find((item) => item.paperId === paper.id)
      const evidence = Math.min(1, (analysis?.evidence.length ?? 0) / 3 + 0.45)
      const bridge = Math.min(1, (analysis?.references.filter((reference) => reference.matchedPaperId).length ?? 0) / 5 + 0.35)
      const total = scorePaper({ relevance, influence, frontier, evidence, bridge })
      return { paperId: paper.id, relevance, influence, frontier, evidence, bridge, total, role: frontier > 0.8 ? 'frontier' as const : influence > 0.72 ? 'hub' as const : 'foundation' as const, reason: '综合主题相关性、本地引用影响力、时间前沿度与证据完整度入选。' }
    })
    const analysisMap = new Map(candidateAnalyses.map((analysis) => [analysis.paperId, analysis]))
    const core = selectDiverseCorePapers(generated.map((score) => ({ id: score.paperId, score: score.total, domains: analysisMap.get(score.paperId)?.domains.map((item) => item.domain) ?? [], terms: [...(analysisMap.get(score.paperId)?.keywordsZh ?? []), ...(analysisMap.get(score.paperId)?.keywordsEn ?? [])], data: score })), Math.min(15, Math.max(12, candidatePapers.length))).map((item) => item.id)
    setPapers(core.map((id) => candidatePapers.find((paper) => paper.id === id)!)); setAnalyses(candidateAnalyses); setScores(generated.filter((score) => core.includes(score.paperId))); setDemoMode(false); setRunning(false)
  }
  return <div className="research-page"><section className="research-header"><div><p className="eyebrow"><BrainCircuit size={13} />AI-ASSISTED LOCAL RETRIEVAL</p><h1>从论文堆中，找到真正值得精读的那一组</h1></div><div className="query-box"><Search size={19} /><input aria-label="科研问题" value={query} onChange={(event) => setQuery(event.target.value)} /><button onClick={() => void run()} disabled={running}>{running ? '正在计算…' : '开始检索'}<ArrowRight size={16} /></button></div><div className="query-options"><button><Filter size={14} />全部知识域<ChevronDown size={13} /></button><button>年份不限<ChevronDown size={13} /></button><span><Sparkles size={14} />IC 术语扩展已启用</span></div></section><div className="result-summary"><div><span>LOCAL RETRIEVAL</span><strong>{candidateCount}</strong><small>候选论文</small></div><i /><div><span>IC-INFLUENCE RANK</span><strong>{papers.length}</strong><small>核心论文</small></div><p>{demoMode ? '当前显示可交互示例图谱；投入本地论文后将自动替换。' : '评分仅基于你的本地论文库与本地引用网络。'}</p></div><GraphWorkbench papers={papers} analyses={analyses} scores={scores.length ? scores : demoScores.slice(0, papers.length)} /></div>
}
