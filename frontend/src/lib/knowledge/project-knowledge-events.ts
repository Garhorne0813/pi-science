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
  let needsCatchUp = false;
  const schedule = () => {
    timer ??= setTimeout(() => {
      const next = needsCatchUp ? undefined : latest;
      latest = undefined;
      needsCatchUp = false;
      timer = null;
      onSignal(next);
    }, SIGNAL_DEBOUNCE_MS);
  };
  const signal = (event: ProjectKnowledgeEvent) => {
    if (!needsCatchUp) latest = event;
    schedule();
  };
  const catchUp = () => {
    // Counts have no revision: once events may have been missed, only REST
    // can reconcile this debounce window, even if another count arrives.
    needsCatchUp = true;
    latest = undefined;
    schedule();
  };
  const closeStream = openJsonEventStream<ProjectKnowledgeEvent>(`/api/project-knowledge/events?cwd=${encodeURIComponent(cwd)}`, {
    onMessage: signal,
    onOpen: ({ resumed, reconnect }) => {
      // Initial mount is paired with the normal REST query. A visibility
      // resume also needs catch-up after the new subscription is live, even
      // when the first EventSource never reached OPEN.
      if (resumed || reconnect) catchUp();
    },
    closeOnError: false,
    pauseWhenHidden: true,
    onResume: catchUp,
  });
  return () => {
    closeStream();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    latest = undefined;
    needsCatchUp = false;
  };
}
