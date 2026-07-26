type ApiRequestOptions = RequestInit & {
  /** Message used when the failed response carries no `detail`/`error`/`message`. */
  errorFallback?: string;
};

export class ApiError extends Error {
  status: number;
  detail?: unknown;

  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** The one place a failed REST payload becomes a message: routes report failures
 *  as `detail` (Python), `error` (Node) or `message` depending on the handler. */
export function apiErrorMessage(payload: unknown, fallback?: string): string {
  const data = typeof payload === "object" && payload ? payload as Record<string, unknown> : undefined;
  const message = data?.detail ?? data?.error ?? data?.message ?? fallback ?? "Request failed";
  return String(message || "Request failed");
}

/** The app's single HTTP transport. Caching, deduplication, retry and invalidation
 *  belong to the QueryClient (lib/query-client.ts) — this only speaks HTTP. */
export async function apiRequest<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
  const { errorFallback, ...init } = options;
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : await response.text();
  if (!response.ok) throw new ApiError(apiErrorMessage(data, errorFallback ?? response.statusText), response.status, data);
  return data as T;
}
