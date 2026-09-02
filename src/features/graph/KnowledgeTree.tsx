import type { PaperAnalysis, PaperRecord } from '../../domain/types'
import { classifyPaperTopicParts } from './topicClassification'

interface TreeChild {
  label: string
  papers: PaperRecord[]
}

interface TreeBranch {
  label: string
  children: TreeChild[]
}

function buildBranches(papers: PaperRecord[], analyses: PaperAnalysis[]): TreeBranch[] {
  const byPaper = new Map(analyses.map((analysis) => [analysis.paperId, analysis]))
  const branchMap = new Map<string, Map<string, PaperRecord[]>>()
  for (const paper of papers) {
    const { broad, focus } = classifyPaperTopicParts(paper, byPaper.get(paper.id))
    const childMap = branchMap.get(broad) ?? new Map<string, PaperRecord[]>()
    childMap.set(focus, [...(childMap.get(focus) ?? []), paper])
    branchMap.set(broad, childMap)
  }
  const branches: TreeBranch[] = []
  for (const [broad, childMap] of branchMap) {
    const children: TreeChild[] = []
    for (const [focus, group] of childMap) {
      if (group.length <= 2) {
        children.push({ label: focus, papers: group })
      } else {
        group.forEach((paper, index) => {
          children.push({ label: `${focus} · ${paper.id.slice(-4)}`, papers: [paper] })
        })
      }
    }
    branches.push({ label: broad, children })
  }
  return branches.sort((a, b) => b.children.reduce((sum, child) => sum + child.papers.length, 0) - a.children.reduce((sum, child) => sum + child.papers.length, 0))
}

export function KnowledgeTree({ papers, analyses, onSelect }: { papers: PaperRecord[]; analyses: PaperAnalysis[]; onSelect: (id: string) => void }) {
  const branches = buildBranches(papers, analyses)
  return (
    <div className="knowledge-tree tree-view">
      <div className="tree-root"><strong>当前科研问题</strong><small>DYNAMIC TOPICS</small></div>
      <div className="tree-branches">
        {branches.map((branch) => (
          <section className="tree-branch" key={branch.label}>
            <h4>{branch.label}<small>{branch.children.reduce((sum, child) => sum + child.papers.length, 0)}</small></h4>
            <div className="tree-children">
              {branch.children.map((child) => (
                <div className="tree-child" key={child.label}>
                  <span className="tree-child-label">{child.label}<small>{child.papers.length}</small></span>
                  <div className="tree-papers">{child.papers.map((paper) => (
                    <button key={paper.id} onClick={() => onSelect(paper.id)}><i />{paper.title}</button>
                  ))}</div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
