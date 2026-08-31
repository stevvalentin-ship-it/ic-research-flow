import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('App', () => {
  it('shows the local-first research workbench entry points', () => {
    render(<App />)
    expect(screen.getByText('芯研流')).toBeInTheDocument()
    expect(screen.getByText('投入集成电路论文')).toBeInTheDocument()
    expect(screen.getByText('连接 DeepSeek')).toBeInTheDocument()
  })
})
