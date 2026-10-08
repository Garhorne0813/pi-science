import { openJsonEventStream } from "../client/event-stream";
import { queryClient } from "../client/query-client";
import { runsKey } from "./runs";

const SIGNAL_DEBOUNCE_MS = 150;

export interface ExecutionEventConnectionOptions {
  onConnectionChange?: (connected: boolean) => void;
}

/** Executions remain REST-backed; this lossy stream only signals that their cache changed. */
export function subscribeExecutionInvalidation(cwd: string, options: ExecutionEventConnectionOptions = {}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const signal = () => {
    timer ??= setTimeout(() => {
      timer = null;
      void queryClient.invalidateQueries({ queryKey: runsKey(cwd) });
    }, SIGNAL_DEBOUNCE_MS);
  };
  const closeStream = openJsonEventStream<unknown>(`/api/executions/events?cwd=${encodeURIComponent(cwd)}`, {
    onMessage: signal,
    onOpen: ({ resumed, reconnect }) => {
      if (resumed || reconnect) signal();
    },
    onConnectionChange: options.onConnectionChange,
    closeOnError: false,
    pauseWhenHidden: true,
    onResume: signal,
  });
  return () => {
    closeStream();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
