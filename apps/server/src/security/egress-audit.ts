/**
 * Lightweight egress audit trail. Every outbound connector request that
 * leaves the machine should be recorded here (connector id, target domain,
 * timestamp, whether the user approved it). Records land in the control-plane
 * config directory as JSONL; no PII beyond the target domain is stored.
 * The audit can be switched off explicitly with config.json `egress_audit: false`.
 */
import { appendJsonLine, configPath, readJson } from "../storage/persistence.js";

export type EgressAuditEntry = {
  connector_type: "mcp" | "literature" | "connector" | "scheduled-task";
  connector_id: string;
  target_domain: string;
  approved: boolean;
  note?: string;
  ts?: number;
};

export async function egressAuditEnabled(): Promise<boolean> {
  const config = await readJson<{ egress_audit?: unknown }>(configPath("config.json"), {});
  return config.egress_audit !== false;
}

/** Normalize a target URL to its bare lowercased hostname; userinfo and port are dropped. Never throws. */
function normalizeTargetDomain(raw: string): string {
  if (!raw) return "unknown";
  try {
    return new URL(raw).hostname.toLowerCase() || "unknown";
  } catch {
    return "unknown";
  }
}

/** Record one outbound request/decision. Never throws: audit must not break the request path. */
export async function recordEgress(entry: EgressAuditEntry): Promise<void> {
  const record = { ...entry, target_domain: normalizeTargetDomain(String(entry.target_domain ?? "")), ts: entry.ts ?? Date.now() / 1000 };
  try {
    await appendJsonLine(configPath("egress-audit.jsonl"), record);
  } catch (error) {
    console.warn(`[pi-science] egress audit write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
