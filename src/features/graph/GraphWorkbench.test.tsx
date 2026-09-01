import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PaperAnalysis, PaperRecord, PaperScore } from '../../domain/types'
import { GraphWorkbench } from './GraphWorkbench'

describe('GraphWorkbench', () => {
  it('shows the selected paper score breakdown and evidence page', async () => {
    const paper = { id: 'p1', title: 'Thermal-Aware Chiplet Placement', year: 2026, authors: ['Lin'] } as PaperRecord
    const analysis = { paperId: 'p1', summary: '热感知布局方法。', domains: [], references: [], evidence: [{ page: 7, label: '结论', quote: '降低峰值温度。' }] } as unknown as PaperAnalysis
    const score = { paperId: 'p1', total: 0.91, relevance: 0.95, influence: 0.86, frontier: 0.9, evidence: 0.8, bridge: 0.5, role: 'frontier', reason: '前沿且证据充分' } as PaperScore
    render(<GraphWorkbench papers={[paper]} analyses={[analysis]} scores={[score]} />)
    await userEvent.click(screen.getAllByText('Thermal-Aware Chiplet Placement')[0])
    expect(screen.getByText('综合得分')).toBeInTheDocument()
    expect(screen.getByText(/PAGE 7/)).toBeInTheDocument()
  })

  it('selects the first paper when a new result set replaces the old one', () => {
    const first = { id: 'old', title: 'Old result', authors: [] } as unknown as PaperRecord
    const next = { id: 'new', title: 'New result', authors: [] } as unknown as PaperRecord
    const makeScore = (paperId: string) => ({ paperId, total: .8, relevance: .8, influence: .8, frontier: .8, evidence: .8, bridge: .8, role: 'hub', reason: '' }) as PaperScore
    const { rerender } = render(<GraphWorkbench papers={[first]} analyses={[]} scores={[makeScore('old')]} />)

    rerender(<GraphWorkbench papers={[next]} analyses={[]} scores={[makeScore('new')]} />)

    expect(screen.getByRole('heading', { name: 'New result' })).toBeInTheDocument()
  })
})
