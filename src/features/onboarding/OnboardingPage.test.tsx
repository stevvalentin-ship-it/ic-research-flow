import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { OnboardingPage } from './OnboardingPage'

describe('OnboardingPage', () => {
  it('does not enable build until files and a valid connection exist', () => {
    render(<MemoryRouter><OnboardingPage /></MemoryRouter>)
    expect(screen.getByRole('button', { name: '开始构建论文库' })).toBeDisabled()
  })
})
