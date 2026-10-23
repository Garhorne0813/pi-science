import { safeConnectorFetch } from "../security/outbound-security.js";

export const MODEL_DISCOVERY_LIMITS = { pages: 10, models: 1000, bytes: 8 * 1024 * 1024, timeoutMs: 10_000 };
const failure = (code: string) => Object.assign(new Error("Model discovery failed"), { code });

/** No partial lists are returned: callers must never publish an incomplete refresh. */
export async function discoverModelRows(url: string, protocol: string, headers: Record<string, string>, allowPrivate: boolean, limits = MODEL_DISCOVERY_LIMITS): Promise<Array<{ id: string; raw: unknown }>> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const deadline = Date.now() + limits.timeoutMs;
  const run = async () => {
    const models = new Map<string, { id: string; raw: unknown }>(), cursors = new Set<string>();
    let cursor: string | undefined, bytes = 0;
    for (let page = 0; page < limits.pages; page++) {
      controller.signal.throwIfAborted();
      // Only the cursor is upstream-controlled. Never follow upstream URLs.
      const target = new URL(url);
      if (protocol === "anthropic") { target.searchParams.set("limit", "100"); if (cursor) target.searchParams.set("after_id", cursor); }
      const response = await safeConnectorFetch(target.toString(), { allowPrivate, maxRedirects: 3, headers,
        maxResponseBytes: limits.bytes - bytes, timeoutMs: Math.max(1, deadline - Date.now()), signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw failure(response.status === 401 || response.status === 403 ? "discovery_auth" : response.status === 404 ? "discovery_unsupported" : response.status === 429 ? "discovery_rate_limited" : "discovery_failed");
      }
      const text = await response.text();
      bytes += Buffer.byteLength(text, "utf8");
      if (bytes > limits.bytes) throw failure("discovery_incomplete");
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        payload = parsed as Record<string, unknown>;
      } catch { throw failure("discovery_invalid_response"); }
      const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : undefined;
      if (!rows) throw failure("discovery_invalid_response");
      for (const raw of rows) {
        const value = typeof raw === "string" ? raw : raw && typeof raw === "object" ? (raw as Record<string, unknown>).id ?? (raw as Record<string, unknown>).name : undefined;
        const id = typeof value === "string" ? value.trim() : "";
        if (!id || id.length > 500) throw failure("discovery_invalid_response");
        if (!models.has(id)) models.set(id, { id, raw });
        if (models.size > limits.models) throw failure("discovery_incomplete");
      }
      if (protocol === "anthropic" && payload.has_more !== undefined && typeof payload.has_more !== "boolean") throw failure("discovery_invalid_response");
      if (protocol !== "anthropic" || payload.has_more !== true) {
        if (!models.size) throw failure("discovery_empty");
        return [...models.values()];
      }
      if (!rows.length || typeof payload.last_id !== "string" || !payload.last_id || payload.last_id.length > 500 || cursors.has(payload.last_id)) throw failure("discovery_incomplete");
      cursor = payload.last_id; cursors.add(cursor);
    }
    throw failure("discovery_incomplete");
  };
  let abort!: () => void;
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => { abort = () => reject(failure("discovery_timeout")); controller.signal.addEventListener("abort", abort, { once: true }); })]);
  } catch (error) {
    if (controller.signal.aborted) throw failure("discovery_timeout");
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("response exceeds size limit")) throw failure("discovery_incomplete");
    if (message.startsWith("connector fetch timed out")) throw failure("discovery_timeout");
    const code = (error as { code?: string }).code;
    if (code?.startsWith("discovery_")) throw error;
    throw failure("discovery_failed");
  } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); }
}
