import { Component, createContext } from 'react'
import type { ReactNode, ErrorInfo, ContextType } from 'react'
import { CrashPanel } from './CrashPanel'

interface Props {
  children: ReactNode
  fallbackLabel?: string
  fallback?: ReactNode | ((retry: () => void) => ReactNode)
}

interface State {
  hasError: boolean
  error: Error | null
  componentStack: string
}

export class ErrorBoundary extends Component<Props, State> {
  static contextType = createContext(undefined)
  declare context: ContextType<typeof ErrorBoundary.contextType>

  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, componentStack: '' }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] 组件崩溃:', error, info)
    this.setState({ componentStack: info.componentStack ?? '' })
  }

  private retry = () => this.setState({ hasError: false, error: null, componentStack: '' })

  private diagnostics = () => {
    const { error, componentStack } = this.state
    return [error?.stack || String(error), componentStack.trim()].filter(Boolean).join('\n\n')
  }

  render() {
    const { fallback } = this.props
    if (this.state.hasError && fallback !== undefined) return typeof fallback === 'function' ? fallback(this.retry) : fallback
    if (this.state.hasError) return <CrashPanel heading={this.props.fallbackLabel} diagnostics={this.diagnostics} onRetry={this.retry} />
    return this.props.children
  }
}
