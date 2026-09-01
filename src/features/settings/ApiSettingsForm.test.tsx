import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiSettingsForm } from './ApiSettingsForm'

describe('ApiSettingsForm', () => {
  it('warns before persisting an API key locally', async () => {
    render(<ApiSettingsForm onConnectionChange={() => undefined} />)
    await userEvent.click(screen.getByLabelText('在本机保存 Key'))
    expect(screen.getByText(/仅保存在当前浏览器/)).toBeInTheDocument()
  })
})
