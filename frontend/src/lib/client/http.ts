/** Fetch wrapper with a request timeout, plus backend error extraction. */

type RequestOptions = RequestInit & { timeoutMs?: number };

export const REQUEST_TIMEOUT_MS = 45_000;
/** Runtime startup can include a cold Pi Orbit host launch. Keep that wait
 * longer than normal REST calls so the first conversation is not abandoned. */
export const RUNTIME_START_TIMEOUT_MS = 180_000;

export async function request(input: RequestInfo | URL, init?: RequestOptions): Promise<Response> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...fetchInit } = init ?? {};
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...fetchInit, credentials: fetchInit.credentials ?? "include", signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Request timed out while contacting the Pi-Science backend");
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export function responseError(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const payload = data as { error?: unknown; detail?: unknown };
    if (typeof payload.error === "string" && payload.error) return payload.error;
    if (typeof payload.detail === "string" && payload.detail) return payload.detail;
  }
  return fallback;
}
