import type { PaperAnalysis, PaperRecord } from '../../domain/types'
import { classifyPaperTopic, findSecondaryFocus } from './topicClassification'

export function KnowledgeTree({ papers, analyses, onSelect }: { papers: PaperRecord[]; analyses: PaperAnalysis[]; onSelect: (id: string) => void }) {
  const byPaper = new Map(analyses.map((analysis) => [analysis.paperId, analysis]))
  const initial = papers.map((paper) => ({ paper, topic: classifyPaperTopic(paper, byPaper.get(paper.id)) }))
  const topicCounts = new Map<string, number>()
  for (const item of initial) topicCounts.set(item.topic, (topicCounts.get(item.topic) ?? 0) + 1)

  const usedFocus = new Set<string>()
  const classified = initial.map((item) => {
    let topic = item.topic
    if ((topicCounts.get(topic) ?? 0) > 2) {
      const secondary = findSecondaryFocus(item.paper, byPaper.get(item.paper.id), usedFocus)
      usedFocus.add(secondary)
      topic = `${topic} · ${secondary}`
    }
    return { ...item, topic }
  })

  const finalCounts = new Map<string, number>()
  for (const item of classified) finalCounts.set(item.topic, (finalCounts.get(item.topic) ?? 0) + 1)
  for (const item of classified) {
    if ((finalCounts.get(item.topic) ?? 0) > 2) {
      item.topic = `${item.topic} · ${item.paper.id.slice(-4)}`
    }
  }

  const topics = [...new Set(classified.map((item) => item.topic))]
  return <div className="knowledge-tree"><div className="tree-root"><strong>当前科研问题</strong><small>DYNAMIC TOPICS</small></div><div className="tree-domains">{topics.map((topic, index) => {
    const group = classified.filter((item) => item.topic === topic)
    return <section key={`${topic}-${index}`}><h4>{topic}<small>{group.length}</small></h4>{group.map(({ paper }) => <button key={paper.id} onClick={() => onSelect(paper.id)}><i />{paper.title}</button>)}</section>
  })}</div></div>
}
