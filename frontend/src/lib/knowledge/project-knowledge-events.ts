import { openJsonEventStream } from "../client/event-stream";

export interface ProjectKnowledgeEvent {
  type: "project-knowledge.changed";
  pending_count: number;
}

const SIGNAL_DEBOUNCE_MS = 250;

/**
 * Project knowledge is changed by background reviews as well as by the current
 * browser tab. The stream is intentionally lossy: the REST query remains the
 * source of truth and reconnects signal a catch-up refresh.
 */
export function subscribeProjectKnowledgeEvents(cwd: string, onSignal: (event?: ProjectKnowledgeEvent) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: ProjectKnowledgeEvent | undefined;
  let connectedOnce = false;
  const signal = (event?: ProjectKnowledgeEvent) => {
    latest = event ?? latest;
    timer ??= setTimeout(() => {
      const next = latest;
      latest = undefined;
      timer = null;
      onSignal(next);
    }, SIGNAL_DEBOUNCE_MS);
  };
  const closeStream = openJsonEventStream<ProjectKnowledgeEvent>(`/api/project-knowledge/events?cwd=${encodeURIComponent(cwd)}`, {
    onMessage: signal,
    onOpen: () => {
      // The initial REST query is already in flight/on cache. Only a later
      // EventSource open represents a reconnect that may have missed events.
      if (connectedOnce) signal();
      connectedOnce = true;
    },
    closeOnError: false,
  });
  return () => {
    closeStream();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    latest = undefined;
  };
}
