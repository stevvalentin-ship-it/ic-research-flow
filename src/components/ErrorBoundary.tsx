import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error?: Error }

export class ErrorBoundary extends Component<Props, State> {
  state: State = {}

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-screen">
          <h1>页面遇到错误</h1>
          <p>{this.state.error.message || '发生了未知错误，请刷新重试。'}</p>
          <button className="primary-button" onClick={() => window.location.reload()}>刷新页面</button>
        </div>
      )
    }
    return this.props.children
  }
}
