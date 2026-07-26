const SIGNAL_DEBOUNCE_MS = 500;

// Lossy invalidation channel for research-loop progress: the server pushes
// lightweight "something changed" events and callers refetch full state on each
// signal. Signals are debounced (trailing, at most one per 500ms) so record
// bursts do not stampede refetches. "open" also signals so a reconnect catches
// up on anything missed while disconnected.
export function subscribeResearchEvents(cwd: string, onSignal: () => void): () => void {
  const source = new EventSource(`/api/project-memory/research-events?cwd=${encodeURIComponent(cwd)}`);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const signal = () => {
    timer ??= setTimeout(() => {
      timer = null;
      onSignal();
    }, SIGNAL_DEBOUNCE_MS);
  };
  source.onmessage = signal;
  source.onopen = signal;
  return () => {
    source.close();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
