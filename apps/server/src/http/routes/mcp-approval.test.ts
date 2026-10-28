import Fastify from "fastify";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { McpConnectorService } from "../../mcp/connector-service.js";
import { McpRuntimeProjection } from "../../mcp/runtime-projection.js";
import { ConversationEventHub } from "../../runtime/events/conversation-event-hub.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { sessionRepository } from "../../runtime/node/session-repository.js";
import { McpRepository } from "../../storage/sqlite/repositories/mcp-repository.js";
import { WorkspaceRepository } from "../../storage/sqlite/repositories/workspace-repository.js";
import { InMemorySqliteStateStore } from "../../storage/sqlite/state-store.js";
import { SettingsStore } from "../../storage/settings-store.js";
import { registerNodeSessionRoutes } from "./node-session-routes.js";

const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(() => vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host"));
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-mcp-approval-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi-science"));
  vi.stubEnv("PI_SCIENCE_HOME", join(cwd, "control"));
  const store = new InMemorySqliteStateStore();
  await store.start(); cleanups.push(() => store.close());
  const repository = new McpRepository(store);
  const workspaces = new WorkspaceRepository(store);
  const projection = new McpRuntimeProjection(repository);
  const mcp = new McpConnectorService(repository, workspaces, new SettingsStore(), undefined, projection);
  await mcp.materializeWorkspace(cwd);
  const connector = await mcp.create({ name: "approval-test", display_name: "Approval test", transport: "stdio", command: process.execPath, runtime_config: {}, enabled: true });
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
  const approve = (requestId = "request", payload = { confirmed: true, alwaysAllow: true }) => app.inject({ method: "POST", url: `/api/sessions/session/interactions/${requestId}?${new URLSearchParams({ cwd })}`, payload });
  const grants = () => repository.projectToolGrants(snapshot.project_id, connector.connector_id);
  return { cwd, repository, projection, mcp, connector, events, pending, notify, approve, grants };
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
