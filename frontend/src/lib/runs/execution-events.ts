import { openJsonEventStream } from "../client/event-stream";
import { queryClient } from "../client/query-client";
import { runsKey } from "./runs";

const SIGNAL_DEBOUNCE_MS = 150;

export interface ExecutionEventConnectionOptions {
  onConnectionChange?: (connected: boolean) => void;
}

interface WorkspaceSubscription {
  connected: boolean;
  listeners: Set<(connected: boolean) => void>;
  close: () => void;
}
const subscriptions = new Map<string, WorkspaceSubscription>();

function createSubscription(cwd: string): WorkspaceSubscription {
  const entry: WorkspaceSubscription = { connected: false, listeners: new Set(), close: () => {} };
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
    onConnectionChange: (connected) => {
      entry.connected = connected;
      for (const listener of entry.listeners) listener(connected);
    },
    closeOnError: false,
    pauseWhenHidden: true,
    onResume: signal,
  });
  entry.close = () => {
    closeStream();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return entry;
}

/** Runs and Notebook share one REST invalidation stream per workspace. */
export function subscribeExecutionInvalidation(cwd: string, options: ExecutionEventConnectionOptions = {}): () => void {
  let entry = subscriptions.get(cwd);
  if (!entry) {
    entry = createSubscription(cwd);
    subscriptions.set(cwd, entry);
  }
  const listener = (connected: boolean) => options.onConnectionChange?.(connected);
  entry.listeners.add(listener);
  listener(entry.connected);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    entry.listeners.delete(listener);
    listener(false);
    if (entry.listeners.size === 0) {
      entry.close();
      if (subscriptions.get(cwd) === entry) subscriptions.delete(cwd);
    }
  };
}
