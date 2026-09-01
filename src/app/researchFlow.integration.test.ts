import type { PaperRecord } from '../domain/types'
import { LocalPaperIndex } from '../search/localSearch'
import { personalizedPageRank } from '../influence/pageRank'
import { scorePaper } from '../influence/scoring'
import { selectDiverseCorePapers } from '../influence/mmr'

describe('local research flow', () => {
  it('retrieves no more than 50 papers and selects 12–15 diverse core papers', () => {
    const papers = Array.from({ length: 60 }, (_, index) => ({
      id: `paper-${index}`, title: `Chiplet thermal TSV study ${index}`, fullText: `die-to-die thermal placement ${index}`,
      fileName: `${index}.pdf`, fileSize: 1, blob: new Blob(), pageCount: 1, createdAt: index, updatedAt: index,
      authors: [], pageTexts: [], analysisStatus: 'completed', analysisVersion: 1,
    })) as PaperRecord[]
    const candidates = new LocalPaperIndex(papers).search('chiplet thermal', 50)
    const ids = candidates.map((item) => item.id)
    const rank = personalizedPageRank({ nodes: ids, edges: ids.slice(1).map((id, index) => ({ source: id, target: ids[index] })) }, Object.fromEntries(candidates.map((item) => [item.id, item.score])))
    const ranked = candidates.map((item, index) => ({ id: item.id, score: scorePaper({ relevance: item.score / candidates[0].score, influence: rank[item.id] / Math.max(...Object.values(rank)), frontier: .7, evidence: .8, bridge: .5 }), domains: [`domain-${index % 4}`], terms: [`term-${index % 7}`] }))
    const core = selectDiverseCorePapers(ranked, 15)

    expect(candidates.length).toBeLessThanOrEqual(50)
    expect(core.length).toBeGreaterThanOrEqual(12)
    expect(core.length).toBeLessThanOrEqual(15)
  })
})
