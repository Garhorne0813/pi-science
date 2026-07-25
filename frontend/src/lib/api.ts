type ApiRequestOptions = RequestInit & {
  cacheTtlMs?: number;
  retries?: number;
};

const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const inFlightGets = new Map<string, Promise<unknown>>();

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

export async function apiRequest<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
  const { cacheTtlMs = 0, retries, ...init } = options;
  const method = (init.method || "GET").toUpperCase();
  const cacheKey = method === "GET" ? url : "";
  const cached = cacheKey ? responseCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;

  // React StrictMode intentionally mounts effects twice in development. Share
  // identical signal-free GETs so the verification cycle does not create a
  // duplicate request (or require aborting the first one during cleanup).
  const dedupeKey = method === "GET" && !init.signal ? url : "";
  const inFlight = dedupeKey ? inFlightGets.get(dedupeKey) : undefined;
  if (inFlight) return inFlight as Promise<T>;

  const request = performRequest<T>();
  if (dedupeKey) inFlightGets.set(dedupeKey, request);
  try {
    return await request;
  } finally {
    if (dedupeKey && inFlightGets.get(dedupeKey) === request) inFlightGets.delete(dedupeKey);
  }

  async function performRequest<TResult>(): Promise<TResult> {
    const attempts = retries ?? (method === "GET" ? 1 : 0);
    let lastError: unknown;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(url, init);
        const contentType = response.headers.get("content-type") || "";
        const data = contentType.includes("application/json")
          ? await response.json().catch(() => ({}))
          : await response.text();
        if (!response.ok) {
          const payload = typeof data === "object" && data ? data as Record<string, unknown> : undefined;
          const message = payload?.detail ?? payload?.error ?? payload?.message ?? response.statusText ?? "Request failed";
          throw new ApiError(String(message || "Request failed"), response.status, data);
        }
        if (cacheKey && cacheTtlMs > 0) responseCache.set(cacheKey, { expiresAt: Date.now() + cacheTtlMs, value: data });
        return data as TResult;
      } catch (error) {
        if (init.signal?.aborted) throw error;
        lastError = error;
        const retryable = !(error instanceof ApiError) || error.status >= 500;
        if (!retryable || attempt === attempts) throw error;
        await new Promise((resolve) => globalThis.setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    throw lastError;
  }
}

export function invalidateApiCache(prefix = "") {
  for (const key of responseCache.keys()) {
    if (!prefix || key.startsWith(prefix)) responseCache.delete(key);
  }
}
