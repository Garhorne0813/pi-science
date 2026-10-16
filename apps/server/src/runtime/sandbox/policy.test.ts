import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalDirectory, isWithin, workspacePolicy } from "./policy.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(await realpath(tmpdir()), "pi-policy-")); roots.push(root); return root; }
it("keeps parent traversal outside the authorized root on the native platform", () => {
  const root = join(process.cwd(), "allowed");
  expect(isWithin(root, join(root, "child"))).toBe(true);
  expect(isWithin(root, join(root, "..", "sibling"))).toBe(false);
});
it("normalizes native trusted-host paths without weakening required alias rejection", async () => {
  const root = await fixture(); const target = join(root, "target"); await mkdir(target);
  const alias = join(root, "alias"); await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host");
  expect((await workspacePolicy(alias + sep)).cwd).toBe(await realpath(target));
  vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
  await expect(workspacePolicy(alias)).rejects.toThrow(/aliases|real directories/);
  await expect(canonicalDirectory(target + sep + "..")).rejects.toThrow("aliases");
});
it.skipIf(process.platform !== "win32")("accepts Windows drive-case and separator normalization without admitting junctions", async () => {
  const root = await fixture();
  const spelling = root[0]!.toLowerCase() + root.slice(1).replaceAll("\\", "/");
  await expect(canonicalDirectory(spelling)).resolves.toBe(spelling);
  vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host");
  expect((await workspacePolicy(spelling)).cwd).toBe(await realpath(root));
});
