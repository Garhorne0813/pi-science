import { Component, useRef, useEffect, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

interface Props {
  children: ReactNode;
  /** Optional fallback UI; defaults to a simple error message. */
  fallback?: ReactNode;
  /** Called when an error is caught. */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

/**
 * React Error Boundary — catches render-time errors in child components.
 * Without this, a single crash in a scientific viewer or chat block takes
 * down the entire application to a blank white page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.props.onError?.(error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="rounded-card border border-error/30 bg-error/5 p-4 text-sm text-text">
            <p className="font-medium text-error">Something went wrong</p>
            <p className="mt-1 text-muted">{this.state.error.message}</p>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-2 rounded-input bg-surface-2 px-3 py-1 text-xs text-text hover:bg-surface"
            >
              Try again
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}

/**
 * ErrorBoundary wrapper that resets error state on route change.
 * Use this inside a Router so errors don't persist across navigation.
 */
export function RoutedErrorBoundary({ children, fallback }: Props) {
  const location = useLocation();
  const ref = useRef<ErrorBoundary>(null);

  useEffect(() => {
    if (ref.current?.state.error) {
      ref.current.setState({ error: null });
    }
  }, [location.pathname]);

  return <ErrorBoundary ref={ref} fallback={fallback}>{children}</ErrorBoundary>;
}
