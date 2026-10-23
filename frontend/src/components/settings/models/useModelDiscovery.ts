import { useEffect, useRef, useState } from "react";
import { apiRequest, ApiError } from "../../../lib/client/api";

export type DiscoveredCapabilities = { context_window?: number; max_output_tokens?: number; reasoning?: boolean; thinking_levels?: string[]; vision?: boolean; tools?: boolean; structured_output?: boolean };
export type DiscoveredModel = { id: string; display_name?: string; kind?: "chat" | "embedding" | "rerank" | "unknown"; capabilities?: DiscoveredCapabilities };
export const discoveryErrors = ["discovery_auth", "discovery_unsupported", "discovery_rate_limited", "discovery_timeout", "discovery_invalid_response", "discovery_empty", "discovery_incomplete", "discovery_failed", "revision_conflict"] as const;
export type DiscoveryErrorCode = typeof discoveryErrors[number];
export function discoveryErrorCode(error: unknown): DiscoveryErrorCode {
  if (!(error instanceof ApiError)) return "discovery_failed";
  const code = (error.detail as { code?: string } | undefined)?.code;
  if (discoveryErrors.includes(code as DiscoveryErrorCode)) return code as DiscoveryErrorCode;
  return error.status === 401 || error.status === 403 ? "discovery_auth" : error.status === 404 ? "discovery_unsupported" : error.status === 429 ? "discovery_rate_limited" : error.status === 409 ? "revision_conflict" : "discovery_failed";
}
type State = { status: "idle" | "loading" | "success" | "error"; models: DiscoveredModel[]; errorCode?: DiscoveryErrorCode; inference_verified: false };
const idle: State = { status: "idle", models: [], inference_verified: false };

/** Editing invalidates the result; only an explicit action sends draft credentials. */
export function useModelDiscovery(enabled: boolean, url: string, api: string, source: string, secret: string, variable: string) {
  const [attempt, setAttempt] = useState(0), lastAttempt = useRef(0), current = useRef<AbortController | null>(null);
  const [state, setState] = useState<State>(idle);
  let validUrl = false;
  try { const parsed = new URL(url); validUrl = ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash; } catch { /* Incomplete draft. */ }
  const ready = enabled && validUrl && (source === "managed" ? Boolean(secret.trim()) : source === "environment" ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) : source === "keyless");
  useEffect(() => {
    const requested = attempt !== lastAttempt.current;
    lastAttempt.current = attempt;
    setState(idle);
    if (!ready || !requested) return;
    const controller = new AbortController(); current.current = controller;
    let active = true;
    setState({ ...idle, status: "loading" });
    const timer = setTimeout(() => { controller.abort(); if (active) setState({ ...idle, status: "error", errorCode: "discovery_timeout" }); }, 15_000);
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    void (async () => {
      try {
        const result = await apiRequest<{ models: DiscoveredModel[]; inference_verified: false }>("/api/model-config/discover", {
          method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base_url: url, api, ...(source === "managed" ? { secret } : source === "environment" ? { environment_variable: variable } : {}) }),
        });
        if (!Array.isArray(result.models) || result.models.some((model) => !model || typeof model.id !== "string")) throw new ApiError("Invalid discovery response", 400, { code: "discovery_invalid_response" });
        if (active && !controller.signal.aborted) setState({ ...idle, status: "success", models: [...new Map(result.models.map((model) => [model.id, model])).values()] });
      } catch (error) { if (active && !controller.signal.aborted) setState({ ...idle, status: "error", errorCode: discoveryErrorCode(error) }); }
      finally { clearTimeout(timer); }
    })();
    return () => { active = false; clearTimeout(timer); controller.abort(); current.current = null; };
  }, [ready, url, api, source, secret, variable, attempt]);
  return { ...state, ready, retry: () => setAttempt((value) => value + 1), cancel: () => { current.current?.abort(); setState(idle); } };
}
