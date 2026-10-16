import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identifyPolicy } from "./policy.js";
import { bindRuntimeReadPolicy, runtimeReadPolicy, runtimeReadPolicyId } from "./read-grants.js";
import { processSettings } from "./settings.js";
import { workerEnvironment } from "../agent/agent-runtime-client.js";

describe.skipIf(process.platform !== "linux")("shared operator runtime read grants", () => {
  let directory: string; let file: string; let dependency: string; let protectedRoot: string; let workspace: string;
  const save = async (dependencyRoots: string[], protectedRoots: string[]) => writeFile(file, JSON.stringify({ schemaVersion: 1, dependencyRoots, protectedRoots }), { mode: 0o600 });
  const settings = (dependencies: string[]) => processSettings(identifyPolicy({ mode: "required", scope: "workspace", cwd: workspace, readPaths: [workspace], writePaths: [], denyPaths: [], network: { mode: "none" } }), dependencies, {});
  beforeEach(async () => {
    await mkdir(resolve("../../.runtime"), { recursive: true });
    directory = await mkdtemp(join(resolve("../../.runtime"), ".read-policy-test-"));
    file = join(directory, "policy.json"); dependency = join(directory, "dependency"); protectedRoot = join(directory, "protected"); workspace = join(directory, "workspace");
    for (const path of [dependency, protectedRoot, workspace]) await mkdir(path, { mode: 0o700 });
    await save([dependency], [protectedRoot]); vi.stubEnv("PI_SCIENCE_SANDBOX_READ_POLICY", file);
  });
  afterEach(async () => { vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true, force: true }); });

  it("derives settings from the same canonical grants and denies the shared protected roots", async () => {
    const policy = await runtimeReadPolicy(); const configured = await settings([dependency]);
    expect(configured.filesystem.allowRead.map((entry) => entry.path)).toEqual(expect.arrayContaining([...policy.systemReads, dependency]));
    expect(configured.filesystem.denyRead.map((entry) => entry.path)).toEqual(expect.arrayContaining([protectedRoot, file]));
    expect(configured.filesystem.denyWrite.map((entry) => entry.path)).toEqual(expect.arrayContaining([protectedRoot, file]));
  });
  it("refuses undeclared per-workspace dependencies until the operator policy is updated", async () => {
    const extra = join(directory, "other-environment"); await mkdir(extra);
    await expect(settings([extra])).rejects.toThrow("outside the shared operator read policy");
    await save([dependency, extra], [protectedRoot]);
    expect((await settings([extra])).filesystem.allowRead.map((entry) => entry.path)).toContain(extra);
  });
  it("revalidates configuration changes instead of retaining a stale approval", async () => {
    await settings([dependency]);
    await save([dependency, directory], [protectedRoot]);
    await expect(settings([dependency])).rejects.toThrow("Protected paths overlap");
    await expect(runtimeReadPolicy()).rejects.toThrow("Protected paths overlap");
  });
  it("rejects a policy changed after a kernel was admitted but before startup", async () => {
    const admitted = identifyPolicy({ mode: "required", scope: "workspace", cwd: workspace, readPaths: [workspace], writePaths: [], denyPaths: [], network: { mode: "none" }, operatorReadPolicyId: runtimeReadPolicyId(await runtimeReadPolicy()) });
    await save([], [protectedRoot]);
    await expect(processSettings(admitted, [], {})).rejects.toThrow("changed before sandbox startup");
    await expect(bindRuntimeReadPolicy(admitted)).rejects.toThrow("changed after admission");
  });
  it("refuses direct protected-root grants even if a caller skips dependency arguments", async () => {
    const policy = identifyPolicy({ mode: "required", scope: "workspace", cwd: workspace, readPaths: [protectedRoot], writePaths: [], denyPaths: [], network: { mode: "none" } });
    await expect(processSettings(policy, [], {})).rejects.toThrow("Protected paths overlap");
    await expect(processSettings(identifyPolicy({ ...policy, readPaths: [workspace], writePaths: [protectedRoot] }), [], {})).rejects.toThrow("Protected paths overlap");
  });
  it("permits ordinary execution without optional operator configuration", async () => {
    delete process.env.PI_SCIENCE_SANDBOX_READ_POLICY;
    await expect(settings([dependency])).resolves.toHaveProperty("filesystem");
    expect((await runtimeReadPolicy()).protectedRoots).toEqual([]);
  });
  it("forwards only the server-selected policy file to Workers", () => {
    expect(workerEnvironment({ PI_SCIENCE_SANDBOX_READ_POLICY: "/untrusted/policy" }).PI_SCIENCE_SANDBOX_READ_POLICY).toBe(file);
  });
  it("rejects writable/readable policy files, links and malformed configuration", async () => {
    await chmod(file, 0o644); await expect(runtimeReadPolicy()).rejects.toThrow("private single-link"); await chmod(file, 0o600);
    const linked = join(directory, "alias"); await link(file, linked); await expect(runtimeReadPolicy()).rejects.toThrow("private single-link"); await rm(linked);
    await symlink(file, linked); vi.stubEnv("PI_SCIENCE_SANDBOX_READ_POLICY", linked); await expect(runtimeReadPolicy()).rejects.toThrow();
    vi.stubEnv("PI_SCIENCE_SANDBOX_READ_POLICY", file); await writeFile(file, '{"schemaVersion":1,'); await expect(runtimeReadPolicy()).rejects.toThrow();
  });
  it("rejects broad roots, aliases to broad roots and unknown fields", async () => {
    await save(["/usr"], [protectedRoot]); await expect(runtimeReadPolicy()).rejects.toThrow("narrow absolute");
    const alias = join(directory, "root-alias"); await symlink("/", alias); await save([alias], [protectedRoot]); await expect(runtimeReadPolicy()).rejects.toThrow("narrow absolute");
    await save([dependency], [protectedRoot]); const value = JSON.parse(await readFile(file, "utf8")); await writeFile(file, JSON.stringify({ ...value, allowAll: true })); await expect(runtimeReadPolicy()).rejects.toThrow();
  });
});
