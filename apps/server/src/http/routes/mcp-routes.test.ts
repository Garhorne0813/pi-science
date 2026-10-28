import { builtinMcpConnectors } from "../../mcp/builtin-connectors.js";
import { SettingsStore } from "../../storage/settings-store.js";
import { readWebSettings } from "../../web/settings.js";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as connectorProbe from "../../mcp/connector-probe.js";
import { McpConnectorService, mcpConnectorFingerprint } from "../../mcp/connector-service.js";
import { McpRuntimeProjection } from "../../mcp/runtime-projection.js";
import { McpRepository } from "../../storage/sqlite/repositories/mcp-repository.js";
import { WorkspaceRepository } from "../../storage/sqlite/repositories/workspace-repository.js";
import { InMemorySqliteStateStore } from "../../storage/sqlite/state-store.js";
import { registerMcpRoutes } from "./mcp-routes.js";

const stores: InMemorySqliteStateStore[] = [];
const directories: string[] = [];
const originalHome = process.env.PI_SCIENCE_HOME;
beforeEach(() => vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host"));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterEach(async () => { await Promise.allSettled(stores.splice(0).map((store) => store.close())); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME; else process.env.PI_SCIENCE_HOME = originalHome; });

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-mcp-routes-")); directories.push(cwd); await mkdir(join(cwd, "src")); await mkdir(join(cwd, ".pi-science"));
  process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
  const store = new InMemorySqliteStateStore(); stores.push(store); await store.start();
  const repository = new McpRepository(store);
  const service = new McpConnectorService(repository, new WorkspaceRepository(store), new SettingsStore(), undefined, new McpRuntimeProjection(repository));
  const app = Fastify({ logger: false }); registerMcpRoutes(app, service);
  await service.materializeWorkspace(cwd);
  return { app, cwd, service, store };
}

describe("canonical MCP routes", () => {
  it("creates, globally configures and deletes a connector while materializing every workspace runtime", async () => {
    const { app, cwd } = await fixture();
    const created = await app.inject({ method: "POST", url: "/api/mcp/connectors", payload: {
      name: "local-tools", display_name: "Local tools", description: "test", transport: "stdio", command: process.execPath, args: ["server.js"],
      runtime_config: { cwd: "src", lifecycle: "lazy", expose_resources: true, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "none", allow_private: false }, enabled: true,
    } });
    expect(created.statusCode).toBe(201);
    const connector = created.json();
    expect(connector).toMatchObject({ name: "local-tools", settings: { enabled: true, approval_mode: "ask" } });

    const listed = await app.inject({ method: "GET", url: "/api/mcp/connectors" });
    expect(listed.json().connectors).toHaveLength(1);
    const snapshot = JSON.parse(await readFile(join(cwd, ".pi-science", "mcp-runtime.json"), "utf8"));
    expect(snapshot.mcpServers["local-tools"]).toMatchObject({ command: process.execPath, args: ["server.js"], cwd: "src", approveTools: true });

    const disabled = await app.inject({ method: "PUT", url: `/api/mcp/connectors/${connector.connector_id}/settings`, payload: { enabled: false, include_tools: [], exclude_tools: [], approval_mode: "ask", revision: connector.settings.revision } });
    expect(disabled.statusCode).toBe(200);
    expect(JSON.parse(await readFile(join(cwd, ".pi-science", "mcp-runtime.json"), "utf8")).mcpServers).toEqual({});

    expect((await app.inject({ method: "DELETE", url: `/api/mcp/connectors/${connector.connector_id}` })).statusCode).toBe(204);
    await app.close();
  });

  it("rejects unsupported credential and literal bindings at the API boundary", async () => {
    const { app } = await fixture();
    for (const extra of [
      { credential_ref: "secret" },
      { runtime_config: { environment: { TOKEN: { kind: "credential", credential_ref: "secret" } } } },
      { runtime_config: { environment: { TOKEN: { kind: "literal", value: "secret" } } } },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/mcp/connectors", payload: {
        name: "unsupported", display_name: "Unsupported", transport: "stdio", command: process.execPath, runtime_config: {}, ...extra,
      } });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("unsupported_binding");
    }
    await app.close();
  });

  it("manages connector credentials without exposing them in runtime snapshots", async () => {
    const { app, cwd, service } = await fixture();
    const connector = await service.create({ name: "remote-auth", display_name: "Remote auth", transport: "streamable_http", endpoint_url: "https://93.184.216.34/mcp", runtime_config: {}, enabled: false });
    await service.repository.replaceToolCache({ connector_id: connector.connector_id, config_revision: connector.revision, fingerprint: mcpConnectorFingerprint((await service.repository.get(connector.connector_id))!), tools: [{ name: "search", title: "Search", description: "", read_only: true, decision: "ask" }], fetched_at: 1, expires_at: Number.MAX_SAFE_INTEGER });
    const saved = await app.inject({ method: "PUT", url: `/api/mcp/connectors/${connector.connector_id}/credential`, payload: { backend: "managed", delivery: "bearer", target_name: "Authorization", secret: "super-secret-token", revision: connector.revision } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ configured: true, backend: "managed", delivery: "bearer", target_name: "Authorization" });
    expect(JSON.stringify(saved.json())).not.toContain("super-secret-token");
    await service.setSettings(connector.connector_id, { enabled: true, include_tools: [], exclude_tools: [], approval_mode: "ask", revision: connector.settings.revision });
    const snapshot = await readFile(join(cwd, ".pi-science", "mcp-runtime.json"), "utf8");
    expect(snapshot).not.toContain("super-secret-token");
    expect(JSON.parse(snapshot).mcpServers["remote-auth"].__piScienceHeaders.Authorization).toMatchObject({ kind: "credential", prefix: "Bearer " });
    expect(await service.repository.toolCache(connector.connector_id)).toBeNull();
    const updated = (await service.get(connector.connector_id));
    const removed = await app.inject({ method: "DELETE", url: `/api/mcp/connectors/${connector.connector_id}/credential` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ credential_ref: null, configured: false });
    expect(updated.revision).toBeGreaterThan(connector.revision);
    await app.close();
  });

  it("keeps unknown tools approval-gated without a discovery cache", async () => {
    const { app, cwd, service } = await fixture();
    const connector = await service.create({ name: "uncached", display_name: "Uncached", transport: "stdio", command: process.execPath, runtime_config: {}, enabled: true });
    await service.setToolGrant(connector.connector_id, "explicitly_allowed", "allow");
    const snapshot = JSON.parse(await readFile(join(cwd, ".pi-science", "mcp-runtime.json"), "utf8"));
    expect(snapshot.mcpServers.uncached).toMatchObject({ approveTools: true, __piScienceAllowedTools: ["explicitly_allowed"] });
    expect(await service.tools(connector.connector_id)).toMatchObject({ tools: [] });
    await app.close();
  });

  it("stores project tool overrides separately from global defaults", async () => {
    const { app, cwd, service } = await fixture();
    const otherCwd = await mkdtemp(join(tmpdir(), "pi-science-mcp-routes-other-"));
    directories.push(otherCwd);
    await mkdir(join(otherCwd, ".pi-science"));
    await service.materializeWorkspace(otherCwd);
    const connector = await service.create({ name: "scoped", display_name: "Scoped", transport: "stdio", command: process.execPath, runtime_config: {}, enabled: true });
    await service.repository.replaceToolCache({ connector_id: connector.connector_id, config_revision: connector.revision, fingerprint: mcpConnectorFingerprint((await service.repository.get(connector.connector_id))!), tools: [{ name: "safe", title: "Safe", description: "", read_only: true, decision: "ask" }], fetched_at: 1, expires_at: Number.MAX_SAFE_INTEGER });
    await service.setToolGrant(connector.connector_id, "safe", "allow");

    const projectDeny = await app.inject({ method: "PUT", url: `/api/mcp/connectors/${connector.connector_id}/tools/safe?cwd=${encodeURIComponent(cwd)}`, payload: { decision: "deny" } });
    expect(projectDeny.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/mcp/connectors/${connector.connector_id}/tools?cwd=${encodeURIComponent(cwd)}` })).json().tools)
      .toEqual([expect.objectContaining({ name: "safe", decision: "deny", decision_scope: "project" })]);

    const otherProjectView = await app.inject({ method: "GET", url: `/api/mcp/connectors/${connector.connector_id}/tools?cwd=${encodeURIComponent(otherCwd)}` });
    expect(otherProjectView.json().scope).toBe("project");
    expect(otherProjectView.json().tools).toEqual([expect.objectContaining({ decision: "allow", decision_scope: "global" })]);
    const currentSnapshot = JSON.parse(await readFile(join(cwd, ".pi-science", "mcp-runtime.json"), "utf8"));
    const otherSnapshot = JSON.parse(await readFile(join(otherCwd, ".pi-science", "mcp-runtime.json"), "utf8"));
    expect(currentSnapshot.mcpServers.scoped).toMatchObject({ excludeTools: ["safe"] });
    expect(otherSnapshot.mcpServers.scoped).toMatchObject({ __piScienceAllowedTools: ["safe"] });

    const reset = await app.inject({ method: "DELETE", url: `/api/mcp/connectors/${connector.connector_id}/tools/safe?cwd=${encodeURIComponent(cwd)}` });
    expect(reset.statusCode).toBe(204);
    expect((await service.tools(connector.connector_id, cwd)).tools).toEqual([expect.objectContaining({ decision: "allow", decision_scope: "global" })]);
    expect(JSON.parse(await readFile(join(cwd, ".pi-science", "mcp-runtime.json"), "utf8")).mcpServers.scoped)
      .toMatchObject({ __piScienceAllowedTools: ["safe"] });
    await app.close();
  });

  it("rejects local connector working directories that escape the workspace", async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: "POST", url: "/api/mcp/connectors", payload: {
      name: "escape", display_name: "Escape", transport: "stdio", command: process.execPath, args: [],
      runtime_config: { cwd: "../outside", lifecycle: "lazy", expose_resources: true, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "none", allow_private: false }, enabled: false,
    } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "workspace_escape" });
    await app.close();
  });

  it("seeds paper-search enabled and scientific connectors disabled without the retired web connector", async () => {
    const { app, cwd, service } = await fixture();
    await service.ensureBuiltins();
    const seededPaper = await service.repository.toolCache("mcp_builtin_paper_search");
    expect(seededPaper?.expires_at).toBe(Number.MAX_SAFE_INTEGER);
    if (seededPaper) await service.repository.replaceToolCache({
      ...seededPaper,
      tools: seededPaper.tools.map((tool, index) => index === 0 ? { ...tool, description: "stale description" } : tool),
    });
    await service.ensureBuiltins();
    expect((await service.repository.toolCache("mcp_builtin_paper_search"))?.expires_at).toBe(Number.MAX_SAFE_INTEGER);
    expect((await service.repository.toolCache("mcp_builtin_paper_search"))?.tools[0]?.description).not.toBe("stale description");
    const listed = await app.inject({ method: "GET", url: `/api/mcp/connectors?cwd=${encodeURIComponent(cwd)}` });
    const connectors = listed.json().connectors as Array<{ connector_id: string; name: string; revision: number; tool_count: number; settings: { enabled: boolean; revision: number } }>;
    expect(connectors).toHaveLength(18);
    expect(connectors.find((item) => item.name === "paper-search")).toMatchObject({ connector_id: "mcp_builtin_paper_search", tool_count: 5, settings: { enabled: true } });
    expect(connectors.find((item) => item.name === "web-access")).toBeUndefined();
    expect(connectors.filter((item) => item.name !== "paper-search")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "literature-graph", tool_count: 5, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "clinical-trials", tool_count: 4, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "structures-interactions", tool_count: 7, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "genes-ontologies", tool_count: 5, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "genomes", tool_count: 5, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "cellguide", tool_count: 5, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "protein-annotation", tool_count: 4, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "omics-archives", tool_count: 7, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "chemistry", tool_count: 7, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "regulation", tool_count: 5, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "biomart", tool_count: 3, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "drug-regulatory", tool_count: 4, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "human-genetics", tool_count: 5, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "protein-records", tool_count: 3, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "nucleotide-archives", tool_count: 3, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "target-discovery", tool_count: 4, settings: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ name: "chembl", tool_count: 4, settings: expect.objectContaining({ enabled: false }) }),
    ]));
    const runtimeSnapshot = JSON.parse(await readFile(join(cwd, ".pi-science", "mcp-runtime.json"), "utf8"));
    expect(runtimeSnapshot.mcpServers["paper-search"]).toMatchObject({ __piScienceCacheVersion: 4, __piScienceToolCount: 5 });
    expect(runtimeSnapshot.mcpServers).not.toHaveProperty("web-access");

    const proteinRecords = connectors.find((item) => item.name === "protein-records")!;
    await service.setSettings(proteinRecords.connector_id, {
      enabled: true,
      include_tools: [],
      exclude_tools: [],
      approval_mode: "ask",
      revision: proteinRecords.settings.revision,
    });
    const proteinSnapshot = JSON.parse(await readFile(join(cwd, ".pi-science", "mcp-runtime.json"), "utf8"));
    expect(proteinSnapshot.mcpServers["protein-records"].directTools).toEqual(["get_uniprot_entry"]);

    expect(await service.credential("mcp_builtin_paper_search")).toMatchObject({ capability: "optional", suggested_target_name: "NCBI_API_KEY" });
    expect(await service.credential("mcp_builtin_literature_graph")).toMatchObject({ capability: "optional", suggested_target_name: "OPENALEX_API_KEY" });
    expect(await service.credential("mcp_builtin_drug_regulatory")).toMatchObject({ capability: "optional", suggested_target_name: "OPENFDA_API_KEY" });
    expect(await service.credential("mcp_builtin_clinical_trials")).toMatchObject({ capability: "unsupported", suggested_delivery: null, suggested_target_name: null });

    const unsupportedCredential = await app.inject({ method: "PUT", url: "/api/mcp/connectors/mcp_builtin_clinical_trials/credential", payload: { backend: "managed", delivery: "environment", target_name: "API_KEY", secret: "unused-key", revision: connectors.find((item) => item.name === "clinical-trials")!.revision } });
    expect(unsupportedCredential.statusCode).toBe(400);
    expect(unsupportedCredential.json()).toMatchObject({ code: "credential_unsupported" });

    const cachedTools = await app.inject({ method: "GET", url: `/api/mcp/connectors/mcp_builtin_paper_search/tools?cwd=${encodeURIComponent(cwd)}` });
    expect(cachedTools.statusCode).toBe(200);
    expect(cachedTools.json().tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["get_europe_pmc_full_text", "search_arxiv", "search_biorxiv_preprints", "search_crossref", "search_pubmed"]);

    const connect = vi.spyOn(connectorProbe, "connectAndListMcpTools");
    const probe = await app.inject({ method: "POST", url: "/api/mcp/connectors/mcp_builtin_paper_search/probe" });
    const probeWorkspace = connect.mock.calls.at(-1)![1];
    expect(probeWorkspace).not.toBe(process.cwd());
    expect(probeWorkspace).toContain("pi-science-mcp-probe-");
    await expect(access(probeWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
    connect.mockRestore();
    expect(probe.statusCode).toBe(200);
    expect(probe.json().tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["get_europe_pmc_full_text", "search_arxiv", "search_biorxiv_preprints", "search_crossref", "search_pubmed"]);

    expect((await app.inject({ method: "DELETE", url: "/api/mcp/connectors/mcp_builtin_paper_search" })).statusCode).toBe(403);

    const literature = connectors.find((item) => item.name === "literature-graph")!;
    const enabled = await app.inject({ method: "PUT", url: `/api/mcp/connectors/${literature.connector_id}/settings`, payload: { enabled: true, include_tools: [], exclude_tools: [], approval_mode: "ask", revision: literature.settings.revision } });
    expect(enabled.statusCode).toBe(200);
    await service.setCredential(literature.connector_id, { backend: "managed", delivery: "environment", target_name: "OPENALEX_API_KEY", secret: "catalog-preserved-secret", revision: literature.revision });
    await service.ensureBuiltins();
    expect((await service.get(literature.connector_id)).settings.enabled).toBe(true);
    expect((await service.get(literature.connector_id)).auth_state).toBe("not-required");
    expect(await service.credential(literature.connector_id)).toMatchObject({ configured: true, delivery: "environment", target_name: "OPENALEX_API_KEY" });
    await app.close();
  });

  it("does not overwrite a custom connector whose name collides with a builtin", async () => {
    const { app, service } = await fixture();
    const custom = await service.create({
      name: "chembl", display_name: "My ChEMBL", description: "user-owned", transport: "stdio", command: process.execPath, args: ["custom-server.js"],
      runtime_config: { lifecycle: "lazy", expose_resources: true, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "none", allow_private: false }, enabled: false,
    });

    await service.ensureBuiltins();
    await service.ensureBuiltins();

    expect(await service.get(custom.connector_id)).toMatchObject({ name: "chembl", display_name: "My ChEMBL", description: "user-owned", source: "custom", command: process.execPath, args: ["custom-server.js"] });
    expect(await service.get("mcp_builtin_chembl")).toMatchObject({ source: "builtin", display_name: "ChEMBL" });
    expect((await service.get("mcp_builtin_chembl")).name).toMatch(/^chembl-builtin-/);
    expect((await service.list()).connectors).toHaveLength(19);
    await app.close();
  });

  it("retires Web Access while preserving its key and global disabled-tool policy", async () => {
    const { app, cwd, service } = await fixture();
    try {
      await service.ensureBuiltins();
      const paper = await service.repository.get("mcp_builtin_paper_search");
      const old = await service.repository.upsertBuiltin("mcp_builtin_web_access", {
        name: "web-access", display_name: "Web Search & Fetch", description: "legacy", transport: "stdio", command: process.execPath,
        args: [], endpoint_url: null, socket_path: null, credential_ref: null, runtime_config: paper!.runtime_config,
      }, true);
      await service.setCredential(old.connector_id, { backend: "managed", delivery: "environment", target_name: "BRAVE_API_KEY", secret: "web-access-test-secret", revision: old.revision });
      await service.repository.setGlobalToolGrant(old.connector_id, "fetch_content", "deny");
      await service.ensureBuiltins();
      expect(await service.repository.get(old.connector_id)).toBeNull();
      expect(await readWebSettings()).toMatchObject({ search_enabled: true, fetch_enabled: false, api_keys: { brave: "web-access-test-secret" } });
      expect(JSON.parse(await readFile(join(cwd, ".pi-science", "mcp-runtime.json"), "utf8")).mcpServers).not.toHaveProperty("web-access");
      expect(await readFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), "utf8")).not.toContain("web-access-test-secret");
      await service.ensureBuiltins();
      expect((await readWebSettings()).fetch_enabled).toBe(false);
    } finally { await app.close(); }
  });

  it("lists globally enabled connectors and cached tools without workspace parameters", async () => {
    const { app, cwd, service } = await fixture();
    await service.ensureBuiltins();

    const listed = await app.inject({ method: "GET", url: "/api/mcp/connectors" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().connectors).toEqual(expect.arrayContaining([expect.objectContaining({ name: "paper-search", source: "builtin", settings: expect.objectContaining({ enabled: true }), tool_count: 5 })]));

    const tools = await app.inject({ method: "GET", url: "/api/mcp/connectors/mcp_builtin_paper_search/tools" });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().tools).toHaveLength(5);

    const grant = await app.inject({ method: "PUT", url: "/api/mcp/connectors/mcp_builtin_paper_search/tools/search_pubmed", payload: { decision: "allow" } });
    expect(grant.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/mcp/connectors" })).json().connectors.find((item: { name: string }) => item.name === "paper-search").settings.approval_mode).toBe("custom");
    expect(JSON.parse(await readFile(join(cwd, ".pi-science", "mcp-runtime.json"), "utf8")).mcpServers["paper-search"])
      .toMatchObject({ approveTools: true, __piScienceAllowedTools: ["search_pubmed"] });
    await app.close();
  });
});


it.each([
  { change: "endpoint", fresh: false }, { change: "endpoint", fresh: true },
  { change: "credential", fresh: false }, { change: "credential", fresh: true },
])("discards delayed discovery after $change changes (fresh cache: $fresh)", async ({ change, fresh }) => {
  const { app, cwd, service, store } = await fixture();
  try {
    const created = await service.create({ name: "racing", display_name: "Racing", transport: "streamable_http", endpoint_url: "https://93.184.216.34/mcp", runtime_config: {}, enabled: true });
    await service.setCredential(created.connector_id, { revision: created.revision, backend: "managed", delivery: "bearer", target_name: "Authorization", secret: "synthetic-account-a" });
    const before = (await service.repository.get(created.connector_id))!;
    const oldTools = [{ name: "account_a", description: "Account A catalog", decision: "ask" as const }];
    const cache = { connector_id: before.connector_id, config_revision: before.revision, fingerprint: mcpConnectorFingerprint(before), tools: oldTools, fetched_at: Date.now(), expires_at: Number.MAX_SAFE_INTEGER };
    expect(await service.repository.replaceToolCache(cache)).toBe(true);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(connectorProbe, "connectAndListMcpTools").mockImplementationOnce(async (connector) => {
      expect(connector.revision).toBe(before.revision);
      enter(); await blocked; return oldTools;
    });
    const pending = service.probe(before.connector_id);
    try {
      await entered;
      if (change === "endpoint") await service.update(before.connector_id, { revision: before.revision, endpoint_url: "https://93.184.216.34/new-endpoint" });
      else await service.setCredential(before.connector_id, { revision: before.revision, backend: "managed", delivery: "bearer", target_name: "Authorization", secret: "synthetic-account-b" });
      expect(await store.get("SELECT config_revision FROM mcp_tool_cache WHERE connector_id = ?", [before.connector_id])).toBeNull();
      const after = (await service.repository.get(before.connector_id))!;
      expect(after.revision).toBeGreaterThan(before.revision);
      const freshTools = [{ name: "account_b", decision: "ask" as const }, { name: "account_b_extra", decision: "ask" as const }];
      if (fresh) expect(await service.repository.replaceToolCache({ ...cache, config_revision: after.revision, fingerprint: mcpConnectorFingerprint(after), tools: freshTools })).toBe(true);
      release();
      expect(await pending).toMatchObject({ runtime_state: "error", error_code: "stale_probe", tools: [] });
      expect((await service.tools(before.connector_id)).tools.map((tool) => tool.name)).toEqual(fresh ? ["account_b", "account_b_extra"] : []);
      expect(await service.repository.toolCache(before.connector_id, before)).toBeNull();
      const saved = await store.get<{ config_revision: number }>("SELECT config_revision FROM mcp_tool_cache WHERE connector_id = ?", [before.connector_id]);
      expect(saved?.config_revision ?? null).toBe(fresh ? after.revision : null);
      await service.materializeWorkspace(cwd);
      const projected = JSON.parse(await readFile(join(cwd, ".pi-science/mcp-runtime.json"), "utf8"));
      expect(projected.mcpServers.racing.__piScienceToolCount).toBe(fresh ? 2 : undefined);
    } finally { release(); await pending; }
  } finally { await app.close(); }
});

it.each(["revision", "fingerprint"])("ignores legacy cached tools with a mismatched %s in lists and projected counts", async (mismatch) => {
  const { app, cwd, service, store } = await fixture();
  try {
    const created = await service.create({ name: "legacy-cache", display_name: "Legacy", transport: "stdio", command: process.execPath, runtime_config: {}, enabled: true });
    const connector = (await service.repository.get(created.connector_id))!;
    await service.repository.replaceToolCache({ connector_id: connector.connector_id, config_revision: connector.revision, fingerprint: mcpConnectorFingerprint(connector), tools: [{ name: "old_catalog", decision: "ask" }], fetched_at: Date.now(), expires_at: Number.MAX_SAFE_INTEGER });
    expect((await service.tools(connector.connector_id)).tools).toHaveLength(1);
    await service.materializeWorkspace(cwd);
    expect(JSON.parse(await readFile(join(cwd, ".pi-science/mcp-runtime.json"), "utf8")).mcpServers[connector.name].__piScienceToolCount).toBe(1);
    await store.run(mismatch === "revision" ? "UPDATE mcp_connectors SET revision = revision + 1 WHERE connector_id = ?" : "UPDATE mcp_tool_cache SET fingerprint = 'obsolete' WHERE connector_id = ?", [connector.connector_id]);
    expect(await service.repository.toolCache(connector.connector_id)).toBeNull();
    const response = await app.inject({ method: "GET", url: `/api/mcp/connectors/${connector.connector_id}/tools` });
    expect(response.json()).toMatchObject({ tools: [], cached_at: null });
    expect(await service.get(connector.connector_id)).toMatchObject({ tool_count: 0, runtime_state: "unknown" });
    await service.materializeWorkspace(cwd);
    expect(JSON.parse(await readFile(join(cwd, ".pi-science/mcp-runtime.json"), "utf8")).mcpServers[connector.name].__piScienceToolCount).toBeUndefined();
  } finally { await app.close(); }
});

it("keeps the current cache when an optimistic update fails or a definition transaction rolls back", async () => {
  const { app, service } = await fixture();
  try {
    const created = await service.create({ name: "stable-cache", display_name: "Stable", transport: "stdio", command: process.execPath, runtime_config: {}, enabled: true });
    await service.update(created.connector_id, { revision: created.revision, args: ["new"] });
    const current = (await service.repository.get(created.connector_id))!;
    const cache = { connector_id: current.connector_id, config_revision: current.revision, fingerprint: mcpConnectorFingerprint(current), tools: [{ name: "fresh_catalog", decision: "ask" as const }], fetched_at: Date.now(), expires_at: Number.MAX_SAFE_INTEGER };
    expect(await service.repository.replaceToolCache(cache)).toBe(true);
    expect(await service.repository.update(current.connector_id, created.revision, current)).toBeNull();
    expect(await service.repository.updateCredential(current.connector_id, created.revision, current.runtime_config, null)).toBeNull();
    const other = await service.create({ name: "conflicting-name", display_name: "Other", transport: "stdio", command: process.execPath, runtime_config: {}, enabled: false });
    await expect(service.repository.update(current.connector_id, current.revision, { ...current, name: other.name })).rejects.toThrow();
    expect(await service.repository.toolCache(current.connector_id)).toMatchObject(cache);
    expect(await service.repository.replaceToolCache({ ...cache, config_revision: created.revision })).toBe(false);
    expect(await service.repository.toolCache(current.connector_id)).toMatchObject(cache);
  } finally { await app.close(); }
});


it("keeps builtin metadata for an unchanged definition and invalidates it on an upgrade", async () => {
  const { app, service, store } = await fixture();
  try {
    const builtin = builtinMcpConnectors()[0]!;
    const before = await service.repository.upsertBuiltin(builtin.connector_id, builtin.definition, true);
    const cache = { connector_id: before.connector_id, config_revision: before.revision, fingerprint: mcpConnectorFingerprint(before), tools: builtin.tools, fetched_at: Date.now(), expires_at: Number.MAX_SAFE_INTEGER };
    await service.repository.replaceToolCache(cache);
    await service.repository.upsertBuiltin(builtin.connector_id, builtin.definition, true);
    expect(await service.repository.toolCache(before.connector_id)).toMatchObject(cache);
    const after = await service.repository.upsertBuiltin(builtin.connector_id, { ...builtin.definition, args: [...builtin.definition.args, "upgrade"] }, true);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(await store.get("SELECT config_revision FROM mcp_tool_cache WHERE connector_id = ?", [before.connector_id])).toBeNull();
    expect(await service.repository.replaceToolCache(cache)).toBe(false);
    expect(await service.repository.toolCache(before.connector_id)).toBeNull();
  } finally { await app.close(); }
});
