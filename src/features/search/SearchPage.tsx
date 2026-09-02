import { ArrowRight, BrainCircuit, ChevronDown, Filter, Search, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PaperAnalysis, PaperRecord, PaperScore } from '../../domain/types'
import { paperRepository } from '../../storage/paperRepository'
import { researchDatabase } from '../../storage/database'
import { LocalPaperIndex } from '../../search/localSearch'
import { retrieveCandidates } from '../../search/retrievalPipeline'
import { personalizedPageRank } from '../../influence/pageRank'
import { computeRelatednessEdges } from '../../influence/relatedness'
import { normalizePaperScores, scorePaper } from '../../influence/scoring'
import { selectDiverseCorePapers } from '../../influence/mmr'
import { matchLocalReferences } from '../../influence/referenceMatcher'
import { setGlobalProgress } from '../../storage/globalProgress'
import { GraphWorkbench } from '../graph/GraphWorkbench'
import { demoAnalyses, demoPapers, demoScores } from './demoData'

function buildLocalScores(papers: PaperRecord[], analyses: PaperAnalysis[], queryRelevance?: Record<string, number>): PaperScore[] {
  const ids = new Set(papers.map((paper) => paper.id))
  const personalization = queryRelevance
    ?? Object.fromEntries(papers.map((paper, index) => [paper.id, 1 / Math.max(1, papers.length) + index * 1e-9]))
  const citationEdges = analyses.flatMap((analysis) => analysis.references
    .filter((reference) => reference.matchedPaperId && ids.has(reference.matchedPaperId))
    .map((reference) => ({ source: analysis.paperId, target: reference.matchedPaperId!, relation: reference.relation })))
  const relatedEdges = computeRelatednessEdges(papers, analyses)
    .map((edge) => ({ source: edge.source, target: edge.target, weight: edge.weight, relation: 'related' as const }))
  const edges = [...citationEdges, ...relatedEdges]
  const rank = personalizedPageRank({
    nodes: [...ids],
    edges,
    years: Object.fromEntries(papers.map((paper) => [paper.id, paper.year])),
  }, personalization)
  const maxRank = Math.max(...Object.values(rank), 1e-6)
  const scores = papers.map((paper) => {
    const analysis = analyses.find((item) => item.paperId === paper.id)
    const relevance = queryRelevance ? (personalization[paper.id] ?? 0) : 0.5
    const influence = (rank[paper.id] ?? 0) / maxRank
    const frontier = paper.year ? Math.max(0.2, 1 - (new Date().getFullYear() - paper.year) / 15) : 0.5
    const evidence = analysis ? Math.min(1, (analysis.evidence?.length ?? 0) / 3 + 0.45) : 0.45
    const bridge = analysis ? Math.min(1, (analysis.references.filter((reference) => reference.matchedPaperId).length) / 5 + 0.35) : 0.35
    const total = scorePaper({ relevance, influence, frontier, evidence, bridge })
    const role = frontier > 0.8 ? 'frontier' as const : influence > 0.72 ? 'hub' as const : 'foundation' as const
    const reason = queryRelevance
      ? '综合主题相关性、本地引用影响力、时间前沿度与证据完整度入选。'
      : '基于本地引用与语义相关性网络的 PageRank 影响力、时间前沿度与证据完整度综合评分。'
    return { paperId: paper.id, relevance, influence, frontier, evidence, bridge, total, role, reason }
  })
  return normalizePaperScores(scores)
}

export function SearchPage() {
  const [query, setQuery] = useState('')
  const [papers, setPapers] = useState<PaperRecord[]>(demoPapers)
  const [analyses, setAnalyses] = useState<PaperAnalysis[]>(demoAnalyses)
  const [scores, setScores] = useState<PaperScore[]>(demoScores)
  const [candidateCount, setCandidateCount] = useState(50)
  const [demoMode, setDemoMode] = useState(true)
  const [running, setRunning] = useState(false)
  useEffect(() => {
    void Promise.all([paperRepository.list(), researchDatabase.analyses.toArray()]).then(([storedPapers, storedAnalyses]) => {
      if (storedPapers.length) {
        const matchedAnalyses = matchLocalReferences(storedPapers, storedAnalyses)
        const initialPapers = storedPapers.slice(0, 15)
        const initialScores = buildLocalScores(initialPapers, matchedAnalyses).sort((a, b) => b.total - a.total)
        setPapers(initialScores.map((score) => initialPapers.find((paper) => paper.id === score.paperId)!))
        setAnalyses(matchedAnalyses)
        setScores(initialScores)
        setDemoMode(false)
        setCandidateCount(storedPapers.length)
      }
    })
  }, [])
  const run = async () => {
    setRunning(true)
    setGlobalProgress({ active: true, label: '正在执行本地检索与影响力排序…', done: 0, total: 1 })
    try {
      const allPapers = await paperRepository.list()
      const allAnalyses = matchLocalReferences(allPapers, await researchDatabase.analyses.toArray())
      if (!allPapers.length) { setPapers(demoPapers); setAnalyses(demoAnalyses); setScores(demoScores); setDemoMode(true); setCandidateCount(50); return }
      const results = await retrieveCandidates(new LocalPaperIndex(allPapers, allAnalyses), query, undefined, 50)
      const candidates = results.length ? results : allPapers.slice(0, 50).map((paper, index) => ({ id: paper.id, score: 1 - index / 50, terms: [] }))
      setCandidateCount(candidates.length)
      const candidatePapers = candidates.map((item) => allPapers.find((paper) => paper.id === item.id)!).filter(Boolean)
      const candidateIds = new Set(candidatePapers.map((paper) => paper.id))
      const candidateAnalyses = allAnalyses.filter((analysis) => candidateIds.has(analysis.paperId))
      const maxRelevance = Math.max(...candidates.map((item) => item.score), 1)
      const personalization = Object.fromEntries(candidates.map((item) => [item.id, item.score / maxRelevance]))
      const generated = buildLocalScores(candidatePapers, candidateAnalyses, personalization)
      const analysisMap = new Map(candidateAnalyses.map((analysis) => [analysis.paperId, analysis]))
      const core = selectDiverseCorePapers(generated.map((score) => ({ id: score.paperId, score: score.total, domains: analysisMap.get(score.paperId)?.domains.map((item) => item.domain) ?? [], terms: [...(analysisMap.get(score.paperId)?.keywordsZh ?? []), ...(analysisMap.get(score.paperId)?.keywordsEn ?? [])], data: score })), Math.min(15, Math.max(12, candidatePapers.length))).map((item) => item.id)
      setPapers(core.map((id) => candidatePapers.find((paper) => paper.id === id)!))
      setAnalyses(candidateAnalyses)
      setScores(generated.filter((score) => core.includes(score.paperId)))
      setDemoMode(false)
    } finally {
      setRunning(false)
      setGlobalProgress({ active: false, label: '', done: 0, total: 0 })
    }
  }
  return <div className="research-page"><section className="research-header"><div><p className="eyebrow"><BrainCircuit size={13} />AI-ASSISTED LOCAL RETRIEVAL</p><h1>从论文堆中，找到真正值得精读的那一组</h1></div><div className="query-box"><Search size={19} /><input aria-label="科研问题" value={query} onChange={(event) => setQuery(event.target.value)} /><button onClick={() => void run()} disabled={running}>{running ? '正在计算…' : '开始检索'}<ArrowRight size={16} /></button></div><div className="query-options"><button><Filter size={14} />全部主题<ChevronDown size={13} /></button><button>年份不限<ChevronDown size={13} /></button><span><Sparkles size={14} />IC 术语扩展已启用</span></div></section><div className="result-summary"><div><span>LOCAL RETRIEVAL</span><strong>{candidateCount}</strong><small>候选论文</small></div><i /><div><span>IC-INFLUENCE RANK</span><strong>{papers.length}</strong><small>核心论文</small></div><p>{demoMode ? '当前显示可交互示例图谱；投入本地论文后将自动替换。' : '评分基于本地引用网络 PageRank、时间前沿度与证据完整度。'}</p></div><GraphWorkbench papers={papers} analyses={analyses} scores={scores.length ? scores : demoScores.slice(0, papers.length)} /></div>
}
