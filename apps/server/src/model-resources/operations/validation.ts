import type { Endpoint, Provider } from "@pi-science/contracts";

export function resourceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function defaultDataEgress(baseUrl: string): Endpoint["data_egress"] {
  const hostname = new URL(normalizeBaseUrl(baseUrl)).hostname;
  return hostname === "localhost" || /^127\./.test(hostname) || hostname === "[::1]" ? "local" : "remote";
}

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "provider";
}

export function now(): string {
  return new Date().toISOString();
}

export function normalizeProtocol(value: unknown): Endpoint["protocol"] {
  const raw = String(value ?? "openai").toLowerCase();
  if (raw === "anthropic" || raw === "anthropic-messages" || raw === "anthropic-compatible") return "anthropic";
  if (raw === "ollama") return "ollama";
  if (raw === "native") return "native";
  return "openai";
}

export function adapterForEndpoint(protocol: Endpoint["protocol"]): Provider["adapter"] {
  if (protocol === "anthropic") return "anthropic-compatible";
  if (protocol === "ollama") return "ollama";
  if (protocol === "native") return "native";
  return "openai-compatible";
}

export function normalizeBaseUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw resourceError("invalid_resource", "base_url is required");
  let url: URL;
  try { url = new URL(raw); } catch { throw resourceError("invalid_resource", "base_url must be a valid absolute URL"); }
  if (!(["http:", "https:"] as string[]).includes(url.protocol)) throw resourceError("invalid_resource", "only http(s) endpoint URLs are allowed");
  if (url.username || url.password) throw resourceError("invalid_resource", "URL credentials are not allowed");
  let normalized = url.toString();
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

export function secureHeaderPolicy(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw resourceError("invalid_resource", "headers_policy must be an object");
  const forbidden = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key", "set-cookie"]);
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key.toLowerCase())) throw resourceError("invalid_resource", `sensitive header is not allowed: ${key}`);
    result[key] = String(raw);
  }
  return result;
}
