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
  let connectedOnce = false;
  const signal = () => {
    timer ??= setTimeout(() => {
      timer = null;
      void queryClient.invalidateQueries({ queryKey: runsKey(cwd) });
    }, SIGNAL_DEBOUNCE_MS);
  };
  const closeStream = openJsonEventStream<unknown>(`/api/executions/events?cwd=${encodeURIComponent(cwd)}`, {
    onMessage: signal,
    onOpen: () => {
      options.onConnectionChange?.(true);
      if (connectedOnce) signal();
      connectedOnce = true;
    },
    onError: () => options.onConnectionChange?.(false),
    closeOnError: false,
  });
  return () => {
    closeStream();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
