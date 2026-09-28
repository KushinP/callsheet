import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/table'
import { errorMessage } from '@/lib/utils'

/**
 * Shown when a query fails.
 *
 * Every list in the app used to fall through to its empty state on failure, so
 * an expired token, a dropped connection or an RLS denial all rendered as
 * "No leads match" — indistinguishable from genuinely having no data.
 */
export function ErrorState({
  error,
  onRetry,
  what = 'this',
}: {
  error: unknown
  onRetry?: () => void
  what?: string
}) {
  return (
    <EmptyState
      icon={<AlertTriangle />}
      title={`Could not load ${what}`}
      description={errorMessage(error, 'Something went wrong talking to the server.')}
      action={
        onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCw />
            Try again
          </Button>
        )
      }
    />
  )
}

interface BoundaryProps { children: ReactNode }
interface BoundaryState { error: Error | null }

/**
 * Catches render-time crashes so one bad component shows a message instead of
 * blanking the whole app — which, with no boundary at all, is what happened.
 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="p-8">
        <ErrorState
          what="this page"
          error={this.state.error}
          onRetry={() => window.location.reload()}
        />
      </div>
    )
  }
}
