export interface JsonEventStreamOptions<T> {
  onMessage: (data: T) => void;
  onOpen?: () => void;
  onError?: (error: Error) => void;
  closeOnError?: boolean;
}

/** Open an unnamed-message SSE stream with consistent JSON/error handling. */
export function openJsonEventStream<T>(url: string, options: JsonEventStreamOptions<T>): () => void {
  const source = new EventSource(url, { withCredentials: true });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };
  source.onmessage = (event) => {
    try {
      options.onMessage(JSON.parse(event.data) as T);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };
  source.onopen = () => options.onOpen?.();
  source.onerror = (event) => {
    if ("data" in event) return;
    if (options.closeOnError !== false) close();
    options.onError?.(new Error("Event stream connection failed"));
  };
  return close;
}
