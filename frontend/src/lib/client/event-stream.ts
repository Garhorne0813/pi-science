export interface JsonEventStreamOptions<T> {
  onMessage: (data: T) => void;
  onOpen?: () => void;
  onError?: (error: Error) => void;
  closeOnError?: boolean;
  /** Release a long-lived subscription while this tab is in the background. */
  pauseWhenHidden?: boolean;
  /** Refresh REST-backed state after events may have been missed. */
  onResume?: () => void;
}

/** Open an unnamed-message SSE stream with consistent JSON/error handling. */
export function openJsonEventStream<T>(url: string, options: JsonEventStreamOptions<T>): () => void {
  let source: EventSource | null = null;
  let closed = false;
  const open = () => {
    if (closed || source) return;
    const next = new EventSource(url, { withCredentials: true });
    source = next;
    next.onmessage = (event) => {
      if (source !== next) return;
      try {
        options.onMessage(JSON.parse(event.data) as T);
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    };
    next.onopen = () => { if (source === next) options.onOpen?.(); };
    next.onerror = (event) => {
      if (source !== next || "data" in event) return;
      if (options.closeOnError !== false) close();
      options.onError?.(new Error("Event stream connection failed"));
    };
  };
  const onVisibilityChange = () => {
    if (document.hidden) {
      source?.close();
      source = null;
    } else if (!closed && !source) {
      options.onResume?.();
      open();
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    if (options.pauseWhenHidden) document.removeEventListener("visibilitychange", onVisibilityChange);
    source?.close();
    source = null;
  };
  if (options.pauseWhenHidden) document.addEventListener("visibilitychange", onVisibilityChange);
  if (!options.pauseWhenHidden || !document.hidden) open();
  return close;
}
