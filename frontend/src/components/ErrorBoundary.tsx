import { Component, useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

/** Prevent a viewer or route render error from blanking the whole workbench. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.props.onError?.(error, errorInfo);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      this.props.fallback ?? (
        <div className="rounded-card border border-error/30 bg-error/5 p-4 text-sm text-text">
          <p className="font-medium text-error">Something went wrong</p>
          <p className="mt-1 text-muted">{this.state.error.message}</p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-2 rounded-input bg-surface-2 px-3 py-1 text-xs text-text hover:bg-surface"
          >
            Try again
          </button>
        </div>
      )
    );
  }
}

/** Reset route errors after navigation so a broken page does not poison the app. */
export function RoutedErrorBoundary({ children, fallback }: Props) {
  const location = useLocation();
  const ref = useRef<ErrorBoundary>(null);

  useEffect(() => {
    if (ref.current?.state.error) ref.current.setState({ error: null });
  }, [location.pathname]);

  return <ErrorBoundary ref={ref} fallback={fallback}>{children}</ErrorBoundary>;
}
