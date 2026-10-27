import type { Endpoint } from "@pi-science/contracts";
import { anthropicBaseUrl } from "../../model-config/protocol-endpoints.js";
import { resourceError } from "./validation.js";

export function modelRows(payload: Record<string, unknown>): Array<{ id: string; raw: unknown }> {
  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const seen = new Set<string>();
  const result: Array<{ id: string; raw: unknown }> = [];
  for (const row of rows) {
    const id = typeof row === "string" ? row.trim() : row && typeof row === "object" ? String((row as Record<string, unknown>).id ?? (row as Record<string, unknown>).name ?? "").trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, raw: row });
  }
  return result;
}

export function redactSecret(message: string, secret: string | null | undefined): string {
  return secret ? message.replaceAll(secret, "[redacted]") : message;
}

export function authHeaders(protocol: Endpoint["protocol"], secret: string | null): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (protocol === "anthropic") headers["anthropic-version"] = "2023-06-01";
  if (!secret) return headers;
  if (protocol === "anthropic") {
    headers["x-api-key"] = secret;
    headers["anthropic-version"] = "2023-06-01";
  } else headers.authorization = `Bearer ${secret}`;
  return headers;
}

export const MAX_MODEL_DISCOVERY_BYTES = 8 * 1024 * 1024;

export async function readBoundedJson(response: Response, maxBytes = MAX_MODEL_DISCOVERY_BYTES): Promise<Record<string, unknown>> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw resourceError("endpoint_probe_failed", "endpoint response is too large");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw resourceError("endpoint_probe_failed", "endpoint response is too large");
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return text ? { message: text } : {}; }
}

export function discoveryPath(endpoint: Pick<Endpoint, "protocol" | "base_url">): string {
  if (endpoint.protocol === "ollama") return `${endpoint.base_url}/api/tags`;
  if (endpoint.protocol === "anthropic") return `${anthropicBaseUrl(endpoint.base_url)}/v1/models`;
  return `${endpoint.base_url}/models`;
}
