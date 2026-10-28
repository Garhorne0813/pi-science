import Fastify from "fastify";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CredentialStore } from "../../model-resources/credential-store.js";
import { loadProjectedServers } from "../../runtime/shared/extensions/pi-science-mcp.js";
import { McpConnectorService } from "../../mcp/connector-service.js";
import { AgentMcpTools } from "../../runtime/agent/worker/mcp-tools.js";
import { InteractionBridge } from "../../runtime/agent/worker/interaction-bridge.js";
import { builtinMcpConnectors } from "../../mcp/builtin-connectors.js";
import { McpRuntimeProjection } from "../../mcp/runtime-projection.js";
import { ConversationEventHub } from "../../runtime/events/conversation-event-hub.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { sessionRepository } from "../../runtime/node/session-repository.js";
import { McpRepository } from "../../storage/sqlite/repositories/mcp-repository.js";
import { WorkspaceRepository } from "../../storage/sqlite/repositories/workspace-repository.js";
import { InMemorySqliteStateStore } from "../../storage/sqlite/state-store.js";
import { metadataRoot } from "../../storage/persistence.js";
import { SettingsStore } from "../../storage/settings-store.js";
import { registerNodeSessionRoutes } from "./node-session-routes.js";

const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(() => vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host"));
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(withServer = false) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-science-mcp-approval-")));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi-science"));
  vi.stubEnv("PI_SCIENCE_HOME", join(cwd, "control"));
  const store = new InMemorySqliteStateStore();
  await store.start(); cleanups.push(() => store.close());
  const repository = new McpRepository(store);
  const workspaces = new WorkspaceRepository(store);
  const projection = new McpRuntimeProjection(repository);
  const credentials = new CredentialStore();
  const mcp = new McpConnectorService(repository, workspaces, new SettingsStore(), undefined, projection, credentials);
  await mcp.materializeWorkspace(cwd);
  const serverScript = join(cwd, "echo.mjs");
  if (withServer) await writeFile(serverScript, [
    `import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};`,
    `import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};`,
    `const server = new McpServer({ name: "approval-test", version: "1" });`,
    `server.registerTool("echo", { description: "Test echo" }, async () => ({ content: [{ type: "text", text: process.env.TOKEN ?? "echo executed" }] }));`,
    `await server.connect(new StdioServerTransport());`,
  ].join("\n"));
  const connector = await mcp.create({ args: withServer ? [serverScript] : [], name: "approval-test", display_name: "Approval test", transport: "stdio", command: process.execPath, runtime_config: {}, enabled: true });
  const snapshot = JSON.parse(await readFile(join(cwd, ".pi-science", "mcp-runtime.json"), "utf8"));
  const server = snapshot.mcpServers[connector.name];
  const events = new ConversationEventHub();
  const pending = { type: "interaction.requested", sessionId: "session", requestId: "request", kind: "permission", method: "confirm",
    mcpGrant: { connectorId: connector.connector_id, toolName: "echo", connectorRevision: server.__piScienceConnectorRevision, settingsRevision: server.__piScienceSettingsRevision } };
  await events.publish(cwd, "session", pending);
  const notify = vi.fn(async () => {
    events.resolvePendingInteraction(cwd, "session", "request");
    return { success: true };
  });
  const app = Fastify(); cleanups.push(() => app.close());
  registerNodeSessionRoutes(app, { notify } as unknown as NodeSessionService, sessionRepository, undefined, undefined, { mcp, events });
  const approve = (requestId = "request", payload = { confirmed: true, alwaysAllow: true }, workspace = cwd) => app.inject({ method: "POST", url: `/api/sessions/session/interactions/${requestId}?${new URLSearchParams({ cwd: workspace })}`, payload });
  const grants = () => repository.projectToolGrants(snapshot.project_id, connector.connector_id);
  return { cwd, repository, workspaces, projection, credentials, mcp, connector, events, pending, notify, approve, grants };
}

it("binds Always allow to a live request and persists only in its project after confirmation", async () => {
  const f = await fixture();
  expect((await f.approve("forged-request")).statusCode).toBe(409);
  expect(f.notify).not.toHaveBeenCalled();
  f.notify.mockImplementationOnce(async () => {
    expect((await f.grants()).has("echo")).toBe(false);
    return { success: true };
  });
  expect((await f.approve()).json()).toEqual({ ok: true, persistentGrant: true });
  expect((await f.grants()).get("echo")).toBe("allow");
  expect((await f.repository.globalToolGrants(f.connector.connector_id)).has("echo")).toBe(false);
});

it("rejects an approval captured before a connector endpoint/command revision changed", async () => {
  const f = await fixture();
  await f.mcp.update(f.connector.connector_id, { revision: f.connector.revision, args: ["changed-server.js"] });
  expect((await f.approve()).statusCode).toBe(409);
  expect(f.notify).not.toHaveBeenCalled();
  expect((await f.grants()).has("echo")).toBe(false);
});

it("never saves a grant when worker confirmation fails, and permits Deny afterwards", async () => {
  const f = await fixture();
  f.notify.mockResolvedValueOnce({ success: false } as never);
  expect((await f.approve()).statusCode).not.toBe(200);
  expect((await f.grants()).has("echo")).toBe(false);
  expect(f.events.pendingInteraction(f.cwd, "session", "request")).toBeDefined();
  expect((await f.approve("request", { confirmed: false, alwaysAllow: false })).statusCode).toBe(200);
  expect((await f.grants()).has("echo")).toBe(false);
});

it.each(["connector", "global-deny", "project-deny"])("does not overwrite concurrent %s changes during confirmation", async (change) => {
  const f = await fixture();
  f.notify.mockImplementationOnce(async () => {
    if (change === "connector") await f.mcp.update(f.connector.connector_id, { revision: f.connector.revision, args: ["new-server.js"] });
    if (change === "global-deny") await f.repository.setGlobalToolGrant(f.connector.connector_id, "echo", "deny");
    if (change === "project-deny") await f.mcp.setToolGrant(f.connector.connector_id, "echo", "deny", f.cwd);
    return { success: true };
  });
  expect((await f.approve()).json()).toMatchObject({ ok: true, persistentGrant: false, warning: expect.stringContaining("allowed once") });
  expect((await f.grants()).get("echo")).not.toBe("allow");
});

it("reports an unverified grant when storage fails after confirmation", async () => {
  const f = await fixture();
  vi.spyOn(f.repository, "allowPendingTool").mockRejectedValueOnce(new Error("storage failed"));
  expect((await f.approve()).json()).toMatchObject({ ok: true, persistentGrant: null, warning: expect.stringContaining("allowed once") });
  expect((await f.grants()).has("echo")).toBe(false);
});

it("explicitly reports a saved grant when projection fails after commit", async () => {
  const f = await fixture();
  vi.spyOn(f.projection, "materialize").mockRejectedValueOnce(new Error("projection failed"));
  expect((await f.approve()).json()).toMatchObject({ ok: true, persistentGrant: true, warning: expect.stringContaining("was saved") });
  expect((await f.grants()).get("echo")).toBe("allow");
  expect(f.events.pendingInteraction(f.cwd, "session", "request")).toBeUndefined();
});


it("finds canonical pending approvals when the HTTP request uses a workspace alias", async () => {
  const f = await fixture();
  const alias = join(f.cwd, "workspace-alias");
  await symlink(f.cwd, alias, process.platform === "win32" ? "junction" : "dir");
  expect((await f.approve("request", { confirmed: true, alwaysAllow: true }, alias)).json())
    .toEqual({ ok: true, persistentGrant: true });
  expect(f.events.pendingInteraction(f.cwd, "session", "request")).toBeUndefined();
  expect((await f.grants()).get("echo")).toBe("allow");
});

it.each(["project", "global"])("keeps a concurrent %s Deny authoritative after an older Allow projection finishes", async (scope) => {
  const f = await fixture();
  // A separate service/projection instance must participate in the same lock.
  const otherProjection = new McpRuntimeProjection(f.repository);
  const otherService = new McpConnectorService(f.repository, f.workspaces, new SettingsStore(), undefined, otherProjection);
  const denyProjection = vi.spyOn(otherProjection, "materialize");
  const capturedAllow = deferred();
  const releaseAllow = deferred();
  const readCache = f.repository.toolCache.bind(f.repository);
  vi.spyOn(f.repository, "toolCache").mockImplementationOnce(async (id) => {
    const cache = await readCache(id);
    // All grant reads have completed, but the old snapshot has not been published.
    capturedAllow.resolve();
    await releaseAllow.promise;
    return cache;
  });
  const approval = f.approve();
  let deny: Promise<void> | undefined;
  try {
    await capturedAllow.promise;
    // The lock must span policy reads and publication, including across processes.
    const owner = JSON.parse(await readFile(join(metadataRoot(f.cwd), "mcp-runtime.json.lock"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    deny = otherService.setToolGrant(f.connector.connector_id, "echo", "deny", scope === "project" ? f.cwd : undefined);
    await vi.waitFor(async () => {
      const grants = scope === "project" ? await f.grants() : await f.repository.globalToolGrants(f.connector.connector_id);
      expect(grants.get("echo")).toBe("deny");
      expect(denyProjection).toHaveBeenCalled();
    });
  } finally {
    releaseAllow.resolve();
    await Promise.all([approval, deny]);
  }
  const snapshot = JSON.parse(await readFile(join(metadataRoot(f.cwd), "mcp-runtime.json"), "utf8"));
  const server = snapshot.mcpServers[f.connector.name];
  expect(server.excludeTools).toContain("echo");
  expect(server.__piScienceAllowedTools ?? []).not.toContain("echo");
});


it("requires approval in a new worker after a successfully approved connector changes", async () => {
  const f = await fixture(true);
  expect((await f.approve()).json()).toEqual({ ok: true, persistentGrant: true });
  const events: Array<Record<string, unknown>> = [];
  const bridge = new InteractionBridge((event) => events.push(event));
  const before = await AgentMcpTools.open(f.cwd, bridge, { PATH: process.env.PATH ?? "" });
  try {
    expect(before.diagnostics).toEqual([]);
    const result = await before.tools[0]!.execute("before", {}, () => undefined, {} as never, {} as never, {} as never);
    expect(result.content).toEqual([{ type: "text", text: "echo executed" }]);
    expect(events).toEqual([]);
  } finally { await before.close(); }

  await f.mcp.update(f.connector.connector_id, { revision: f.connector.revision, args: [...f.connector.args, "changed-server-identity"] });
  expect((await f.grants()).has("echo")).toBe(false);
  const after = await AgentMcpTools.open(f.cwd, bridge, { PATH: process.env.PATH ?? "" });
  try {
    expect(after.diagnostics).toEqual([]);
    const call = after.tools[0]!.execute("after", {}, () => undefined, {} as never, {} as never, {} as never);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ kind: "permission", mcpGrant: { connectorId: f.connector.connector_id, toolName: "echo" } });
    bridge.notify("extension_ui_response", { id: events[0]!.id, confirmed: false });
    expect(await call).toMatchObject({ isError: true, details: { declined: true } });
  } finally { bridge.close(); await after.close(); }
}, 20_000);

it.each([
  { command: "changed-executable" },
  { transport: "streamable_http", command: null, endpoint_url: "https://93.184.216.34/mcp" },
  { args: ["changed-server.js"] },
])("expires project Allow when connection configuration changes: %j", async (change) => {
  const f = await fixture();
  await f.approve();
  await f.mcp.setToolGrant(f.connector.connector_id, "blocked", "deny", f.cwd);
  await f.mcp.update(f.connector.connector_id, { revision: f.connector.revision, ...change });
  expect((await f.grants()).get("echo")).toBeUndefined();
  expect((await f.grants()).get("blocked")).toBe("deny");
  const snapshot = JSON.parse(await readFile(join(metadataRoot(f.cwd), "mcp-runtime.json"), "utf8"));
  expect(snapshot.mcpServers[f.connector.name].__piScienceAllowedTools ?? []).not.toContain("echo");
});

it("expires project Allow on credential addition, replacement and removal while retaining Deny", async () => {
  const f = await fixture();
  await f.approve();
  await f.mcp.setToolGrant(f.connector.connector_id, "blocked", "deny", f.cwd);
  for (const secret of ["synthetic-first-key", "synthetic-replacement-key", null]) {
    if (secret) {
      const connector = await f.mcp.get(f.connector.connector_id);
      await f.mcp.setCredential(f.connector.connector_id, { revision: connector.revision, backend: "managed", delivery: "environment", target_name: "TOKEN", secret });
    } else await f.mcp.removeCredential(f.connector.connector_id);
    expect((await f.grants()).get("echo")).toBeUndefined();
    expect((await f.grants()).get("blocked")).toBe("deny");
    await f.mcp.setToolGrant(f.connector.connector_id, "echo", "allow", f.cwd);
  }
});

it("does not revoke fresh project grants when an optimistic configuration/credential update fails", async () => {
  const f = await fixture();
  await f.mcp.update(f.connector.connector_id, { revision: f.connector.revision, args: ["new-server.js"] });
  await f.mcp.setToolGrant(f.connector.connector_id, "echo", "allow", f.cwd);
  await expect(f.mcp.update(f.connector.connector_id, { revision: f.connector.revision, args: ["stale-server.js"] })).rejects.toMatchObject({ code: "revision_conflict" });
  const current = await f.repository.get(f.connector.connector_id);
  expect(await f.repository.updateCredential(f.connector.connector_id, f.connector.revision, current!.runtime_config, null)).toBeNull();
  expect((await f.grants()).get("echo")).toBe("allow");
});

it("expires builtin project Allow only when its definition revision changes", async () => {
  const f = await fixture();
  const builtin = builtinMcpConnectors()[0]!;
  const connector = await f.repository.upsertBuiltin(builtin.connector_id, builtin.definition, true);
  await f.mcp.setToolGrant(connector.connector_id, "echo", "allow", f.cwd);
  await f.mcp.setToolGrant(connector.connector_id, "blocked", "deny", f.cwd);
  const projectId = JSON.parse(await readFile(join(metadataRoot(f.cwd), "mcp-runtime.json"), "utf8")).project_id;
  await f.repository.upsertBuiltin(builtin.connector_id, builtin.definition, true);
  expect((await f.repository.projectToolGrants(projectId, connector.connector_id)).get("echo")).toBe("allow");
  await f.repository.upsertBuiltin(builtin.connector_id, { ...builtin.definition, args: [...builtin.definition.args, "changed-builtin"] }, true);
  expect((await f.repository.projectToolGrants(projectId, connector.connector_id)).get("echo")).toBeUndefined();
  expect((await f.repository.projectToolGrants(projectId, connector.connector_id)).get("blocked")).toBe("deny");
});


it("rolls back grant revocation when the connector update cannot commit", async () => {
  const f = await fixture();
  await f.approve();
  const other = await f.mcp.create({ name: "other-connector", display_name: "Other", transport: "stdio", command: process.execPath, runtime_config: {}, enabled: false });
  const current = await f.repository.get(f.connector.connector_id);
  await expect(f.repository.update(f.connector.connector_id, f.connector.revision, { ...current!, name: other.name })).rejects.toThrow();
  expect((await f.grants()).get("echo")).toBe("allow");
  expect((await f.repository.get(f.connector.connector_id))?.revision).toBe(f.connector.revision);
});

it("expires Allow in every project while leaving other connectors' grants intact", async () => {
  const f = await fixture();
  await f.approve();
  const otherCwd = join(f.cwd, "other-project");
  await mkdir(join(otherCwd, ".pi-science"), { recursive: true });
  await f.mcp.materializeWorkspace(otherCwd);
  await f.mcp.setToolGrant(f.connector.connector_id, "echo", "allow", otherCwd);
  const otherProject = JSON.parse(await readFile(join(metadataRoot(otherCwd), "mcp-runtime.json"), "utf8")).project_id;
  const untouched = await f.mcp.create({ name: "untouched", display_name: "Untouched", transport: "stdio", command: process.execPath, runtime_config: {}, enabled: true });
  await f.mcp.setToolGrant(untouched.connector_id, "echo", "allow", otherCwd);
  await f.mcp.update(f.connector.connector_id, { revision: f.connector.revision, args: ["changed-server.js"] });
  expect((await f.grants()).has("echo")).toBe(false);
  expect((await f.repository.projectToolGrants(otherProject, f.connector.connector_id)).has("echo")).toBe(false);
  expect((await f.repository.projectToolGrants(otherProject, untouched.connector_id)).get("echo")).toBe("allow");
});


it.each(["failure", "conflict"])("keeps old approved identity observable while a staged credential rotation ends in %s", async (outcome) => {
  const f = await fixture(true);
  await f.mcp.setCredential(f.connector.connector_id, { revision: f.connector.revision, backend: "managed", delivery: "environment", target_name: "TOKEN", secret: "synthetic-old-secret" });
  await f.mcp.setToolGrant(f.connector.connector_id, "echo", "allow", f.cwd);
  const before = (await f.repository.get(f.connector.connector_id))!;
  let staged: string | null = null;
  vi.spyOn(f.repository, "updateCredential").mockImplementationOnce(async (_id, _revision, _runtime, credentialRef) => {
    staged = credentialRef;
    expect(staged).not.toBe(before.credential_ref);
    expect((await f.credentials.getForRuntime(staged!))?.secret).toBe("synthetic-new-secret");
    expect((await f.credentials.getForRuntime(before.credential_ref!))?.secret).toBe("synthetic-old-secret");
    expect((loadProjectedServers(f.cwd)[f.connector.name]!.env as Record<string, string>).TOKEN).toBe("synthetic-old-secret");
    expect((await f.grants()).get("echo")).toBe("allow");
    const events: unknown[] = [];
    const worker = await AgentMcpTools.open(f.cwd, new InteractionBridge((event) => events.push(event)), { PATH: process.env.PATH ?? "" });
    try {
      expect(worker.diagnostics).toEqual([]);
      const result = await worker.tools[0]!.execute("during-rotation", {}, () => undefined, {} as never, {} as never, {} as never);
      expect(result.content).toEqual([{ type: "text", text: "synthetic-old-secret" }]);
      expect(events).toEqual([]);
    } finally { await worker.close(); }
    if (outcome === "failure") throw new Error("injected database failure after staging");
    return null;
  });
  await expect(f.mcp.setCredential(f.connector.connector_id, { revision: before.revision, backend: "managed", delivery: "environment", target_name: "TOKEN", secret: "synthetic-new-secret" })).rejects.toThrow();
  expect(staged).not.toBeNull();
  expect(await f.credentials.metadata(staged!)).toBeNull();
  expect((await f.repository.get(f.connector.connector_id))?.credential_ref).toBe(before.credential_ref);
  expect((await f.grants()).get("echo")).toBe("allow");
  expect((loadProjectedServers(f.cwd)[f.connector.name]!.env as Record<string, string>).TOKEN).toBe("synthetic-old-secret");
}, 20_000);

it.each(["lost-acknowledgement", "projection-failure"])("retains a committed credential and revoked grants after %s", async (failure) => {
  const f = await fixture();
  await f.mcp.setCredential(f.connector.connector_id, { revision: f.connector.revision, backend: "managed", delivery: "environment", target_name: "TOKEN", secret: "synthetic-old-secret" });
  await f.mcp.setToolGrant(f.connector.connector_id, "echo", "allow", f.cwd);
  const before = (await f.repository.get(f.connector.connector_id))!;
  if (failure === "lost-acknowledgement") {
    const update = f.repository.updateCredential.bind(f.repository);
    vi.spyOn(f.repository, "updateCredential").mockImplementationOnce(async (...args) => {
      await update(...args);
      throw new Error("commit succeeded but acknowledgement was lost");
    });
  } else vi.spyOn(f.projection, "materialize").mockRejectedValueOnce(new Error("projection failed"));
  await expect(f.mcp.setCredential(f.connector.connector_id, { revision: before.revision, backend: "managed", delivery: "environment", target_name: "TOKEN", secret: "synthetic-new-secret" })).rejects.toThrow();
  const committed = (await f.repository.get(f.connector.connector_id))!;
  expect(committed.credential_ref).not.toBe(before.credential_ref);
  expect((await f.credentials.getForRuntime(committed.credential_ref!))?.secret).toBe("synthetic-new-secret");
  expect((await f.grants()).get("echo")).toBeUndefined();
  // A failed publication still resolves the old identity, never the staged one.
  expect((loadProjectedServers(f.cwd)[f.connector.name]!.env as Record<string, string>).TOKEN).toBe("synthetic-old-secret");
  await f.mcp.materializeWorkspace(f.cwd);
  expect((loadProjectedServers(f.cwd)[f.connector.name]!.env as Record<string, string>).TOKEN).toBe("synthetic-new-secret");
  const snapshot = JSON.parse(await readFile(join(metadataRoot(f.cwd), "mcp-runtime.json"), "utf8"));
  expect(snapshot.mcpServers[f.connector.name].__piScienceAllowedTools ?? []).not.toContain("echo");
});

it("publishes a fresh credential reference before retiring the old one, preserving an omitted managed secret", async () => {
  const f = await fixture();
  await f.mcp.setCredential(f.connector.connector_id, { revision: f.connector.revision, backend: "managed", delivery: "environment", target_name: "TOKEN", secret: "synthetic-preserved-secret" });
  await f.mcp.setToolGrant(f.connector.connector_id, "echo", "allow", f.cwd);
  const before = (await f.repository.get(f.connector.connector_id))!;
  await f.mcp.setCredential(f.connector.connector_id, { revision: before.revision, backend: "managed", delivery: "environment", target_name: "NEW_TOKEN" });
  const after = (await f.repository.get(f.connector.connector_id))!;
  expect(after.credential_ref).not.toBe(before.credential_ref);
  expect(await f.credentials.metadata(before.credential_ref!)).toBeNull();
  expect((await f.credentials.getForRuntime(after.credential_ref!))?.secret).toBe("synthetic-preserved-secret");
  expect((loadProjectedServers(f.cwd)[f.connector.name]!.env as Record<string, string>).NEW_TOKEN).toBe("synthetic-preserved-secret");
  expect((await f.grants()).get("echo")).toBeUndefined();
});


it("keeps concurrent rotations isolated and removes only the unpublished losing credential", async () => {
  const f = await fixture();
  await f.mcp.setCredential(f.connector.connector_id, { revision: f.connector.revision, backend: "managed", delivery: "environment", target_name: "TOKEN", secret: "synthetic-old-secret" });
  await f.mcp.setToolGrant(f.connector.connector_id, "echo", "allow", f.cwd);
  const before = (await f.repository.get(f.connector.connector_id))!;
  const bothStaged = deferred();
  const update = f.repository.updateCredential.bind(f.repository);
  const staged: string[] = [];
  vi.spyOn(f.repository, "updateCredential").mockImplementation(async (...args) => {
    staged.push(args[3]!);
    if (staged.length === 2) bothStaged.resolve();
    await bothStaged.promise;
    return update(...args);
  });
  const outcomes = await Promise.allSettled(["synthetic-first-secret", "synthetic-second-secret"].map((secret) => f.mcp.setCredential(f.connector.connector_id, {
    revision: before.revision, backend: "managed", delivery: "environment", target_name: "TOKEN", secret,
  })));
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(new Set(staged).size).toBe(2);
  const committed = (await f.repository.get(f.connector.connector_id))!;
  const active = (await f.credentials.getForRuntime(committed.credential_ref!))!;
  expect(active.secret).toMatch(/^synthetic-(first|second)-secret$/);
  const losing = staged.find((id) => id !== committed.credential_ref)!;
  expect(await f.credentials.metadata(losing)).toBeNull();
  expect(await f.credentials.metadata(before.credential_ref!)).toBeNull();
  expect((loadProjectedServers(f.cwd)[f.connector.name]!.env as Record<string, string>).TOKEN).toBe(active.secret);
  expect((await f.grants()).get("echo")).toBeUndefined();
});
