import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readSessionApproval, saveSessionApproval, sessionApprovalPath } from "./session-approval.js";
import { identifyPolicy, workspacePolicy } from "./policy.js";
import { domainAllowed } from "./network.js";
import { prepareSandbox } from "./process.js";
import { changeNetworkGrant, grantedNetwork, readNetworkGrants } from "./network-grants.js";
let root: string, cwd: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "session-approval-")));
  cwd = join(root, "workspace"); await mkdir(cwd);
  const home = join(root, "home"); await mkdir(home); vi.stubEnv("HOME", home);
  vi.stubEnv("PI_SCIENCE_HOME", join(root, "private"));
  vi.stubEnv("PI_SCIENCE_SANDBOX_PROFILES", "");
  vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it("defaults to ask, persists by workspace/session, and rejects stale changes", async () => {
  expect(await readSessionApproval(cwd, "a")).toEqual({ mode: "ask", revision: 0 });
  expect(await saveSessionApproval(cwd, "a", "auto", 0)).toEqual({ mode: "auto", revision: 1 });
  expect(await readSessionApproval(cwd, "a")).toEqual({ mode: "auto", revision: 1 });
  expect(await readSessionApproval(cwd, "b")).toEqual({ mode: "ask", revision: 0 });
  const other = join(root, "other"); await mkdir(other);
  expect(await readSessionApproval(other, "a")).toEqual({ mode: "ask", revision: 0 });
  await expect(saveSessionApproval(cwd, "a", "full", 0)).rejects.toThrow("changed");
  await writeFile(await sessionApprovalPath(cwd, "a"), "broken");
  await expect(readSessionApproval(cwd, "a")).rejects.toThrow();
});
it("auto allows public HTTPS while retaining workspace files, operator denials and user denials", async () => {
  await saveSessionApproval(cwd, "a", "auto", 0);
  const policy = await workspacePolicy(cwd, undefined, "analysis", "a");
  expect(policy.writePaths).toEqual([cwd]);
  expect(domainAllowed("rest.uniprot.org", 443, policy.network)).toBe(true);
  expect(domainAllowed("rest.uniprot.org", 80, policy.network, "http")).toBe(false);
  expect(domainAllowed("pastebin.com", 443, policy.network)).toBe(false);
  await changeNetworkGrant({ profile: "analysis", domain: "rest.uniprot.org", decision: "deny" }, "settings");
  expect(domainAllowed("rest.uniprot.org", 443, grantedNetwork(policy.network, await readNetworkGrants(), "analysis"))).toBe(false);
  const ask = await workspacePolicy(cwd, undefined, "analysis", "b");
  expect(domainAllowed("rest.uniprot.org", 443, ask.network)).toBe(false);
});
it("full expands home access, protects application state and never broadens confined policies", async () => {
  const deep = join(homedir(), "projects", "nested", "config"); await mkdir(deep, { recursive: true });
  const credential = join(deep, ".env.local"); await writeFile(credential, "TEST_SECRET=value");
  await saveSessionApproval(cwd, "a", "full", 0);
  const full = await workspacePolicy(cwd, undefined, "analysis", "a");
  expect(full.writePaths).toContain(await realpath(homedir()));
  expect(full.denyPaths).toContain(await realpath(join(root, "private")));
  const { sessionPolicy } = await import("./session-approval.js");
  const confined = identifyPolicy({ ...full, scope: "confined", readPaths: [cwd], writePaths: [cwd], network: { mode: "none" } });
  expect(await sessionPolicy(confined, "a")).toBe(confined);
  if (!["linux", "darwin"].includes(process.platform)) {
    await expect(prepareSandbox(full, ["true"], [], 1)).rejects.toThrow("disabled on this platform");
    return;
  }
  const prepared = await prepareSandbox(full, ["true"], [], 1);
  try {
    const manifest = JSON.parse(await readFile(prepared.manifest, "utf8"));
    const settings = JSON.parse(await readFile(manifest.settings, "utf8"));
    expect(settings.filesystem.denyRead).toContainEqual({ path: credential, literal: true });
  } finally { await prepared.cleanup(); }
});
it.skipIf(process.env.PI_SCIENCE_SANDBOX_TEST !== "1" || !["darwin", "linux"].includes(process.platform))("enforces full-mode home access and service-data denial in a real sandbox", async () => {
  const fixture = await realpath(await mkdtemp(join(homedir(), "pi-science-mode-test-")));
  try {
    await writeFile(join(fixture, "sample.txt"), "PUBLIC_TEST_FILE");
    await mkdir(join(fixture, ".pi-science"));
    await writeFile(join(fixture, ".pi-science", "state.json"), "PRIVATE_APP_STATE");
    const deep = join(fixture, "projects", "nested", "config"); await mkdir(deep, { recursive: true });
    const credential = join(deep, ".env"); await writeFile(credential, "ORIGINAL_SECRET_BYTES");
    cwd = join(fixture, "workspace"); await mkdir(cwd);
    await saveSessionApproval(cwd, "a", "full", 0);
    const { sandboxBashTool } = await import("../agent/worker/sandbox-bash.js");
    const { NodeExecutionEnv, BACKGROUND_CONTEXT } = await import("@earendil-works/pi-agent-core/node");
    const tool = sandboxBashTool({ cwd, sessionId: "a" });
    const invocation = { operationId: "test-op", invocationId: "test-call", turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} };
    const path = await sessionApprovalPath(cwd, "a");
    const result = await tool.execute("read-fixture", { command: `cat '${join(fixture, "sample.txt")}'; if cat '${path}' 2>/dev/null; then echo PRIVATE_LEAK; else echo PRIVATE_BLOCKED; fi; if cat '${join(fixture, ".pi-science", "state.json")}' 2>/dev/null; then echo APP_LEAK; else echo APP_BLOCKED; fi; if cat '${credential}' 2>/dev/null; then echo ENV_LEAK; else echo ENV_BLOCKED; fi; printf CHANGED > '${credential}' 2>/dev/null || true` }, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation, BACKGROUND_CONTEXT);
    expect(JSON.stringify(result)).toContain("PUBLIC_TEST_FILE");
    expect(JSON.stringify(result)).toContain("PRIVATE_BLOCKED");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_LEAK");
    expect(JSON.stringify(result)).toContain("APP_BLOCKED");
    expect(JSON.stringify(result)).not.toContain("APP_LEAK");
    expect(JSON.stringify(result)).toContain("ENV_BLOCKED");
    expect(JSON.stringify(result)).not.toContain("ENV_LEAK");
    expect(await readFile(credential, "utf8")).toBe("ORIGINAL_SECRET_BYTES");
    const { createReadTool, createWriteTool } = await import("@earendil-works/pi-agent-core/node");
    const { workspaceFileTool } = await import("../agent/worker/workspace-file-tool.js");
    const env = new NodeExecutionEnv({ cwd });
    const call = (tool: ReturnType<typeof workspaceFileTool>, target: string) => tool.execute("file-mode", { path: target, content: "UPDATED_TEST_FILE" }, () => {}, { env }, invocation, BACKGROUND_CONTEXT);
    expect(JSON.stringify(await call(workspaceFileTool(createReadTool(), cwd, [], "a"), join(fixture, "sample.txt")))).toContain("PUBLIC_TEST_FILE");
    await expect(call(workspaceFileTool(createReadTool(), cwd, [], "b"), join(fixture, "sample.txt"))).rejects.toThrow("outside");
    await expect(call(workspaceFileTool(createReadTool(), cwd, [], "a"), path)).rejects.toThrow("service-owned");
    await call(workspaceFileTool(createWriteTool(), cwd, [], "a"), join(fixture, "new.txt"));
    expect(await readFile(join(fixture, "new.txt"), "utf8")).toBe("UPDATED_TEST_FILE");
  } finally { await rm(fixture, { recursive: true, force: true }); }
}, 30_000);

it("keeps identical writes at the same revision and still rejects stale no-ops", async () => {
  expect(await saveSessionApproval(cwd, "a", "ask", 0)).toEqual({ mode: "ask", revision: 0 });
  await saveSessionApproval(cwd, "a", "auto", 0);
  expect(await saveSessionApproval(cwd, "a", "auto", 1)).toEqual({ mode: "auto", revision: 1 });
  await expect(saveSessionApproval(cwd, "a", "auto", 0)).rejects.toThrow("changed");
});

it("revokes automatic HTTPS and home grants on the next execution policy resolution", async () => {
  await saveSessionApproval(cwd, "a", "full", 0);
  expect((await workspacePolicy(cwd, undefined, "analysis", "a")).readPaths).toContain(await realpath(homedir()));
  await saveSessionApproval(cwd, "a", "auto", 1);
  const auto = await workspacePolicy(cwd, undefined, "analysis", "a");
  expect(auto.readPaths).not.toContain(await realpath(homedir()));
  expect(domainAllowed("example.org", 443, auto.network)).toBe(true);
  await saveSessionApproval(cwd, "a", "ask", 2);
  expect(domainAllowed("example.org", 443, (await workspacePolicy(cwd, undefined, "analysis", "a")).network)).toBe(false);
});
