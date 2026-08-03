import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configPath } from "../storage/persistence.js";
import { egressAuditEnabled, recordEgress } from "./egress-audit.js";

let home: string;
const originalHome = process.env.PI_SCIENCE_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pi-egress-audit-"));
  process.env.PI_SCIENCE_HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

describe("egress audit", () => {
  it("records one JSONL entry with normalized domain and timestamp", async () => {
    await recordEgress({ connector_type: "literature", connector_id: "pubmed", target_domain: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils?term=x", approved: true });
    const lines = (await readFile(configPath("egress-audit.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.connector_type).toBe("literature");
    expect(entry.connector_id).toBe("pubmed");
    expect(entry.target_domain).toBe("eutils.ncbi.nlm.nih.gov");
    expect(entry.approved).toBe(true);
    expect(typeof entry.ts).toBe("number");
  });

  it("falls back to unknown when the target cannot be normalized", async () => {
    await recordEgress({ connector_type: "mcp", connector_id: "local", target_domain: "", approved: false });
    const lines = (await readFile(configPath("egress-audit.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0]!).target_domain).toBe("unknown");
  });

  it("normalizes a target with credentials and port to the bare hostname", async () => {
    await recordEgress({ connector_type: "mcp", connector_id: "x", target_domain: "https://user:pass@example.com:8443/api?q=1", approved: false });
    const lines = (await readFile(configPath("egress-audit.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0]!).target_domain).toBe("example.com");
  });

  it("never throws even when the audit JSONL path is occupied by a directory", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await mkdir(configPath("egress-audit.jsonl"));
      await recordEgress({ connector_type: "mcp", connector_id: "x", target_domain: "a.com", approved: false });
      // Assert before mockRestore: restore clears the call history.
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain("[pi-science] egress audit write failed");
    } finally {
      warn.mockRestore();
    }
  });

  it("is enabled by default and can be disabled via config.json", async () => {
    expect(await egressAuditEnabled()).toBe(true);
    await writeFile(configPath("config.json"), JSON.stringify({ egress_audit: false }), "utf8");
    expect(await egressAuditEnabled()).toBe(false);
  });
});
