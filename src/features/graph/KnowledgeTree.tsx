import type { PaperAnalysis, PaperRecord } from '../../domain/types'
import { classifyPaperTopic } from './topicClassification'

export function KnowledgeTree({ papers, analyses, onSelect }: { papers: PaperRecord[]; analyses: PaperAnalysis[]; onSelect: (id: string) => void }) {
  const byPaper = new Map(analyses.map((analysis) => [analysis.paperId, analysis]))
  const classified = papers.map((paper) => ({ paper, topic: classifyPaperTopic(paper, byPaper.get(paper.id)) }))
  const topics = [...new Set(classified.map((item) => item.topic))]
  return <div className="knowledge-tree"><div className="tree-root"><strong>当前科研问题</strong><small>DYNAMIC TOPICS</small></div><div className="tree-domains">{topics.map((topic, index) => {
    const group = classified.filter((item) => item.topic === topic)
    return <section key={`${topic}-${index}`}><h4>{topic}<small>{group.length}</small></h4>{group.map(({ paper }) => <button key={paper.id} onClick={() => onSelect(paper.id)}><i />{paper.title}</button>)}</section>
  })}</div></div>
}
