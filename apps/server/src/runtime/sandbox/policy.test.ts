import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, realpath, rm, symlink, link, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalDirectory, isWithin, protectedPaths, workspacePolicy } from "./policy.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), readdir: vi.fn(actual.readdir) };
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
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
it.skipIf(process.platform !== "darwin")("accepts the macOS /var system alias while still rejecting workspace symlinks", async () => {
  const root = await fixture();
  const alias = root.replace("/private/var/", "/var/");
  expect(alias).not.toBe(root);
  await expect(canonicalDirectory(alias)).resolves.toBe(root);
  await mkdir(join(root, "real")); await symlink(join(root, "real"), join(root, "link"), "dir");
  await expect(canonicalDirectory(join(root, "link"))).rejects.toThrow("aliases");
});
it.skipIf(process.platform !== "win32")("accepts Windows drive-case and separator normalization without admitting junctions", async () => {
  const root = await fixture();
  const spelling = root[0]!.toLowerCase() + root.slice(1).replaceAll("\\", "/");
  await expect(canonicalDirectory(spelling)).resolves.toBe(spelling);
  vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host");
  expect((await workspacePolicy(spelling)).cwd).toBe(await realpath(root));
});

it("allows ordinary research scripts while denying linked, private and credential paths beneath them", async () => {
  const root = await fixture(); const scripts = join(root, "research/study/evaluator"); await mkdir(scripts, { recursive: true });
  const script = join(scripts, "evaluate.py"); const protocol = join(root, "research/study/evaluation.yaml");
  await writeFile(script, "print('task evaluator')"); await writeFile(protocol, "version: 1");
  await writeFile(join(scripts, "credentials.json"), "SECRET"); await writeFile(join(root, "regular.txt"), "public");
  await link(join(root, "regular.txt"), join(scripts, "linked.txt")); await symlink(join(root, "regular.txt"), join(scripts, "alias.txt"));
  vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required"); const policy = await workspacePolicy(root);
  expect(policy.denyPaths.some((path) => isWithin(path, script) || isWithin(path, protocol))).toBe(false);
  for (const name of ["credentials.json", "linked.txt", "alias.txt"]) expect(policy.denyPaths).toContain(join(scripts, name));
  expect(policy.denyPaths).toContain(join(root, ".pi-science"));
});

it("refreshes every file's link count even when its parent directory is unchanged", async () => {
  const root = await fixture(), outside = await fixture();
  const paths = Array.from({ length: 97 }, (_, index) => join(root, `helper-${index}.py`));
  await Promise.all(paths.map((path) => writeFile(path, "print('helper')")));
  const first = await protectedPaths(root);
  expect(paths.every((path) => !first.includes(path))).toBe(true);
  const before = await stat(root);
  // A link created outside the scanned tree changes nlink without invalidating
  // any directory listing inside it. Directory-mtime caches would miss this.
  const linked = paths[48]!;
  await link(linked, join(outside, "external-link.py"));
  expect((await stat(root)).mtimeMs).toBe(before.mtimeMs);
  const second = await protectedPaths(root);
  expect(second).toContain(linked);
  expect(paths.filter((path) => second.includes(path))).toEqual([linked]);
});

it("detects fresh nested secrets and directory-to-symlink replacements on the next scan", async () => {
  const root = await fixture(), outside = await fixture();
  const nested = join(root, "resources/deep"), replaced = join(root, "helpers");
  await mkdir(nested, { recursive: true }); await mkdir(replaced);
  const first = await protectedPaths(root);
  const secret = join(nested, "credentials.json");
  expect(first).not.toContain(secret); expect(first).not.toContain(replaced);
  await writeFile(secret, "new-secret");
  await rm(replaced, { recursive: true });
  await symlink(outside, replaced, process.platform === "win32" ? "junction" : "dir");
  expect(await protectedPaths(root)).toEqual(expect.arrayContaining([secret, replaced]));
});

it("fails closed when directory enumeration or metadata inspection fails", async () => {
  const root = await fixture();
  await writeFile(join(root, "helper.py"), "public");
  vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error("metadata unavailable"), { code: "EACCES" }));
  await expect(protectedPaths(root)).rejects.toThrow("metadata unavailable");
  vi.mocked(fs.readdir).mockRejectedValueOnce(new Error("directory unavailable"));
  await expect(protectedPaths(root)).rejects.toThrow("directory unavailable");
});

it.each([false, true])("refuses a tree exceeding the inspection cap before returning partial protection (nested: %s)", async (nested) => {
  const root = await fixture();
  await mkdir(join(root, "child"));
  const entries = await fs.readdir(root, { withFileTypes: true });
  if (nested) vi.mocked(fs.readdir).mockResolvedValueOnce(Array(1).fill(entries[0]));
  // Only the count is needed: the guard must reject before inspecting entries.
  vi.mocked(fs.readdir).mockResolvedValueOnce(Array(nested ? 100_000 : 100_001).fill(entries[0]));
  await expect(protectedPaths(root)).rejects.toThrow("Workspace too large");
});
