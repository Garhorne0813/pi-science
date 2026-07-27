import { projectMemoryKey } from "./project-memory";
import { queryClient } from "./query-client";
import { openJsonEventStream } from "./event-stream";

const SIGNAL_DEBOUNCE_MS = 500;

// Lossy invalidation channel for research-loop progress: the server pushes
// lightweight "something changed" events and callers refetch full state on each
// signal. Signals are debounced (trailing, at most one per 500ms) so record
// bursts do not stampede refetches. "open" also signals so a reconnect catches
// up on anything missed while disconnected.
export function subscribeResearchEvents(cwd: string, onSignal: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const signal = () => {
    timer ??= setTimeout(() => {
      timer = null;
      onSignal();
    }, SIGNAL_DEBOUNCE_MS);
  };
  const closeStream = openJsonEventStream<unknown>(`/api/project-memory/research-events?cwd=${encodeURIComponent(cwd)}`, {
    onMessage: signal,
    onOpen: signal,
    closeOnError: false,
  });
  return () => {
    closeStream();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

/** The bridge from the SSE channel to the REST cache: a server signal marks every
 *  project-memory query stale, so whatever is mounted refetches itself. */
export function subscribeResearchInvalidation(cwd: string, onSignal?: () => void): () => void {
  return subscribeResearchEvents(cwd, () => {
    void queryClient.invalidateQueries({ queryKey: projectMemoryKey() });
    onSignal?.();
  });
}
