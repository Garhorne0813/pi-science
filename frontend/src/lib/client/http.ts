/** Fetch wrapper with a request timeout, plus backend error extraction. */

export const REQUEST_TIMEOUT_MS = 45_000;

export async function request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, credentials: init?.credentials ?? "include", signal: controller.signal });
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
