import type { PaperAnalysis, PaperRecord } from '../../domain/types'

export function KnowledgeTree({ papers, analyses, onSelect }: { papers: PaperRecord[]; analyses: PaperAnalysis[]; onSelect: (id: string) => void }) {
  const byPaper = new Map(analyses.map((analysis) => [analysis.paperId, analysis]))
  const domains = [...new Set(papers.flatMap((paper) => byPaper.get(paper.id)?.domains.map((item) => item.domain) ?? ['未分类']))]
  return <div className="knowledge-tree"><div className="tree-root"><strong>当前科研问题</strong><small>CONTENT MAP</small></div><div className="tree-domains">{domains.map((domain) => <section key={domain}><h4>{domain}</h4>{papers.filter((paper) => (byPaper.get(paper.id)?.domains[0]?.domain ?? '未分类') === domain).map((paper) => <button key={paper.id} onClick={() => onSelect(paper.id)}><i />{paper.title}</button>)}</section>)}</div></div>
}
