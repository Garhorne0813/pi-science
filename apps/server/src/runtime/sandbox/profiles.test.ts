import { chmod, link, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it as platformTest, vi } from "vitest";
import { workspacePolicy, identifyPolicy } from "./policy.js";
import { applySandboxProfile, profileConfiguration } from "./profiles.js";
import { processSettings } from "./settings.js";
import { workerEnvironment } from "../agent/agent-runtime-client.js";
import { providerHelperPolicy } from "./provider-policy.js";
const it = platformTest.skipIf(!["linux", "darwin"].includes(process.platform));

let root: string, workspace: string, granted: string, config: string;
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "profiles-"));
  workspace = join(root, "workspace"); granted = join(root, "grant"); config = join(root, "profiles.json");
  await mkdir(workspace); await mkdir(granted);
  vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required"); vi.stubEnv("PI_SCIENCE_SANDBOX_PROFILES", config);
  await save();
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const save = (profiles: unknown = { analysis: { allowedDomains: ["example.com"] }, mcp: { allowedDomains: ["api.example.com:8443"] } }) => writeFile(config, JSON.stringify({ schemaVersion: 1, userReadPaths: [granted], userWritePaths: [], profiles }), { mode: 0o600 });
it("keeps host grants and network allowlists separate for analysis, MCP and control helpers", async () => {
  const analysis = await workspacePolicy(workspace);
  expect(analysis.readPaths).toContain(granted); expect(analysis.writePaths).not.toContain(granted);
  expect(analysis.network).toMatchObject({ mode: "allowlist", allowedDomains: ["example.com:443"] });
  const mcp = await workspacePolicy(workspace, undefined, "mcp");
  expect(mcp.network).toMatchObject({ allowedDomains: ["api.example.com:8443"] });
  for (const role of ["control", "byoc", "install"] as const) {
    const policy = await workspacePolicy(workspace, undefined, role);
    expect(policy.readPaths).not.toContain(granted); expect(policy.writePaths).not.toContain(granted);
  }
});
it("never lets a candidate inherit grants or gain network access", async () => {
  const candidate = identifyPolicy({ mode: "required", scope: "candidate", cwd: workspace, readPaths: [workspace], writePaths: [workspace], denyPaths: [], network: { mode: "none" } });
  await expect(applySandboxProfile(candidate, "analysis")).rejects.toThrow("broader");
  const bound = await applySandboxProfile(candidate, "candidate");
  expect(bound.readPaths).toEqual([workspace]); expect(bound.network).toEqual({ mode: "none" });
  await expect(processSettings(identifyPolicy({ ...candidate, network: { mode: "allowlist", allowedDomains: ["example.com:443"], deniedDomains: [] } }), [])).rejects.toThrow("broader");
});
it("refuses profile changes after admission and changes persistent-kernel policy identity", async () => {
  const before = await workspacePolicy(workspace);
  await save({ analysis: { allowedDomains: ["other.example.com"] } });
  expect((await workspacePolicy(workspace)).id).not.toBe(before.id);
  await expect(processSettings(before, [])).rejects.toThrow("changed after admission");
});
it("rejects writable configurations, aliases and unknown widening switches", async () => {
  await chmod(config, 0o644); await expect(profileConfiguration()).rejects.toThrow("private single-link"); await chmod(config, 0o600);
  await link(config, join(root, "alias")); await expect(profileConfiguration()).rejects.toThrow("private single-link"); await rm(join(root, "alias"));
  await writeFile(config, JSON.stringify({ schemaVersion: 1, profiles: { candidate: { allowedDomains: ["example.com"] } } }));
  await expect(profileConfiguration()).rejects.toThrow();
});
it("rejects wildcard-all, private IP and invalid-port domain grants", async () => {
  for (const domain of ["*", "127.0.0.1:443", "localhost", "x.local", "example.com:70000", "https://example.com"]) {
    await save({ analysis: { allowedDomains: [domain] } }); await expect(profileConfiguration()).rejects.toThrow();
  }
});
it("does not accept profile configuration overrides from a workspace Worker", () => {
  expect(workerEnvironment({ PI_SCIENCE_SANDBOX_PROFILES: "/untrusted" }).PI_SCIENCE_SANDBOX_PROFILES).toBe(config);
});
it("refuses host grants covering the operator policy or broad filesystem roots", async () => {
  await writeFile(config, JSON.stringify({ schemaVersion: 1, userReadPaths: [root] }));
  await expect(workspacePolicy(workspace)).rejects.toThrow("overlaps");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, userReadPaths: ["/"] }));
  await expect(workspacePolicy(workspace)).rejects.toThrow("narrow");
});
it("binds each provider helper to its own approved endpoint, SDK and stage without host grants", async () => {
  const stage = join(root, "stage"), runtime = join(root, "sdk"); await mkdir(stage); await mkdir(runtime);
  await save({ byoc: { allowedDomains: ["first.example.com", "second.example.com"] } });
  const input = { workspace, stage, runtime };
  const first = await providerHelperPolicy({ ...input, endpoint: "https://first.example.com/v1" });
  expect(first.network).toMatchObject({ mode: "allowlist", allowedDomains: ["first.example.com:443"] });
  expect(first.readPaths).toContain(runtime); expect(first.writePaths).not.toContain(runtime); expect(first.readPaths).not.toContain(granted);
  expect((await providerHelperPolicy(input)).network).toEqual({ mode: "none" });
  expect((await providerHelperPolicy({ ...input, endpoint: "https://second.example.com" })).id).not.toBe(first.id);
  await expect(providerHelperPolicy({ ...input, endpoint: "https://unapproved.example.com" })).rejects.toThrow("not approved");
  await expect(providerHelperPolicy({ ...input, endpoint: "http://first.example.com" })).rejects.toThrow("HTTPS");
});
