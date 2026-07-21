type ApiRequestOptions = RequestInit & {
  cacheTtlMs?: number;
  retries?: number;
};

const responseCache = new Map<string, { expiresAt: number; value: unknown }>();

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
        const message = typeof data === "object" && data && "detail" in data
          ? String((data as { detail: unknown }).detail)
          : response.statusText || "Request failed";
        throw new ApiError(message, response.status, data);
      }
      if (cacheKey && cacheTtlMs > 0) responseCache.set(cacheKey, { expiresAt: Date.now() + cacheTtlMs, value: data });
      return data as T;
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

export function invalidateApiCache(prefix = "") {
  for (const key of responseCache.keys()) {
    if (!prefix || key.startsWith(prefix)) responseCache.delete(key);
  }
}
