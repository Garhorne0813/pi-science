import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareSandbox } from "../runtime/sandbox/process.js";
import { processSettings } from "../runtime/sandbox/settings.js";
import { saveSessionApproval } from "../runtime/sandbox/session-approval.js";
import { localMcpTransport } from "./sandbox-transport.js";

vi.mock("../runtime/sandbox/process.js", async (original) => ({
  ...await original<typeof import("../runtime/sandbox/process.js")>(),
  prepareSandbox: vi.fn(async () => ({ manifest: "unused", shell: "unused", env: {}, cleanup: async () => {} })),
}));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mcp-scope-"))); roots.push(root);
  const cwd = join(root, "workspace"), home = join(root, "state"), grant = join(root, "host-grant");
  await mkdir(cwd); await mkdir(home); await mkdir(grant);
  vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required"); vi.stubEnv("PI_SCIENCE_HOME", home);
  const config = join(root, "profiles.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, userReadPaths: [grant], userWritePaths: [grant], profiles: { mcp: { allowedDomains: ["api.example.com"] } } }), { mode: 0o600 });
  vi.stubEnv("PI_SCIENCE_SANDBOX_PROFILES", config);
  return { cwd, home, grant };
}
const supported = ["linux", "darwin"].includes(process.platform);
it.skipIf(!supported).each(["paper-search", "literature-graph"])("keeps %s outside workspace/full-session filesystem grants and scans", async (name) => {
  const { cwd, grant } = await fixture();
  vi.stubEnv("PI_SCIENCE_SANDBOX_RUNTIME_PATHS", JSON.stringify([grant]));
  vi.stubEnv("PI_SCIENCE_SANDBOX_PYTHON_ROOT", grant);
  await saveSessionApproval(cwd, "session", "full", 0);
  await localMcpTransport(cwd, process.execPath, [], cwd, {}, name, "session");
  const [policy, , dependencies] = vi.mocked(prepareSandbox).mock.calls[0]!;
  expect(policy.readPaths).toEqual([]); expect(policy.writePaths).toEqual([]);
  expect(policy.cwd).not.toBe(cwd);
  expect(policy.network).toMatchObject({ mode: "allowlist", allowedDomains: ["api.example.com:443"] });
  const { config: settings } = await processSettings(policy, dependencies);
  expect(JSON.stringify(settings.filesystem)).not.toContain(cwd);
  expect(JSON.stringify(settings.filesystem)).not.toContain(grant);
  expect(settings.filesystem.denyRead.every((entry) => typeof entry !== "string")).toBe(true);
});
it.skipIf(!supported)("preserves workspace and operator filesystem grants for user stdio connectors", async () => {
  const { cwd, grant } = await fixture();
  await localMcpTransport(cwd, process.execPath, [], cwd, {});
  const [policy] = vi.mocked(prepareSandbox).mock.calls[0]!;
  expect(policy.cwd).toBe(cwd); expect(policy.readPaths).toEqual(expect.arrayContaining([cwd, grant]));
  expect(policy.writePaths).toEqual(expect.arrayContaining([cwd, grant]));
});
