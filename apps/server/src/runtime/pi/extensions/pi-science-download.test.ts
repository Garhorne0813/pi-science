import { afterEach, describe, expect, it, vi } from "vitest";
import registerDownload from "./pi-science-download.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function tool() {
  const registered: Record<string, any> = {};
  registerDownload({ registerTool(value: any) { registered[value.name] = value; } });
  return registered;
}

const params = { url: "https://files.rcsb.org/download/4HHB.cif", destination: "structures/4HHB.cif" };
const context = (select: ReturnType<typeof vi.fn>) => ({ cwd: "/tmp/workspace", sessionManager: { getSessionId: () => "session-1" }, ui: { select } });

describe("download extensions", () => {
  it("keeps URL and protein-structure inputs separate", () => {
    expect(tool().download_url.parameters.required).toEqual(["url", "destination"]);
    expect(tool().download_url.parameters.properties).not.toHaveProperty("accession");
    expect(tool().download_protein_structure.parameters.required).toEqual(["accession"]);
    expect(tool().download_protein_structure.parameters.properties).not.toHaveProperty("url");
  });

  it("resolves a UniProt accession through one domain tool call", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ destination: "structures/P30520/2V40.cif", accession: "P30520", protein: { protein_name: "Adenylosuccinate synthetase isozyme 2", organism_name: "Homo sapiens", taxon_id: 9606, sequence_length: 456 }, source: "experimental", structure_id: "2V40", size: 10, sha256: "a".repeat(64), artifact_id: "artifact-1" })));
    globalThis.fetch = fetch;
    const result = await tool().download_protein_structure.execute("call", { accession: "P30520" }, undefined, undefined, context(vi.fn()));
    expect(result.isError).not.toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toContain("/api/downloads/protein-structure");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ accession: "P30520" });
  });

  it("accepts a workspace destination alongside the accession", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ destination: "data/structures/P30520.cif", accession: "P30520", protein: { protein_name: "Adenylosuccinate synthetase isozyme 2", organism_name: "Homo sapiens", taxon_id: 9606, sequence_length: 456 }, source: "experimental", structure_id: "2V40", validation: "mmCIF header identifies 2V40", size: 10, sha256: "a".repeat(64), artifact_id: "artifact-1" })));
    globalThis.fetch = fetch;
    const result = await tool().download_protein_structure.execute("call", { accession: "P30520", destination: "data/structures/P30520.cif" }, undefined, undefined, context(vi.fn()));
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ accession: "P30520", destination: "data/structures/P30520.cif" });
    expect(result.content[0].text).toContain("Downloaded and validated experimental structure 2V40");
    expect(result.content[0].text).toContain("Homo sapiens");
  });

  it("asks the user before granting the blocked host and retries", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "network_access_required", host: "files.rcsb.org" }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ host: "files.rcsb.org" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ destination: params.destination, size: 10, sha256: "a".repeat(64), artifact_id: "artifact-1" }), { status: 200 }));
    globalThis.fetch = fetch;
    const select = vi.fn().mockResolvedValue("Allow for this session");
    const result = await tool().download_url.execute("call", params, undefined, undefined, context(select));
    expect(result.isError).not.toBe(true);
    expect(select).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toMatchObject({ session_id: "session-1", url: "https://files.rcsb.org/" });
  });

  it("does not grant or retry when approval is denied", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "network_access_required", host: "files.rcsb.org" }), { status: 403 }));
    globalThis.fetch = fetch;
    const result = await tool().download_url.execute("call", params, undefined, undefined, context(vi.fn().mockResolvedValue("Deny")));
    expect(result.isError).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the session workspace when the shared Orbit host has a different workspace env", async () => {
    vi.stubEnv("PI_WORKSPACE_DIR", "/tmp/orbit-host");
    try {
      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ destination: params.destination, size: 10, sha256: "a".repeat(64), artifact_id: "artifact-1" })));
      globalThis.fetch = fetch;
      await tool().download_url.execute("call", params, undefined, undefined, context(vi.fn()));
      expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ cwd: "/tmp/workspace" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
