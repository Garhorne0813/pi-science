import { mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoveryBackendAvailable } from "./workspace-discovery-contract.js";
import { directory } from "./workspace-discovery-directory.js";
import { darwinDirectory } from "./workspace-discovery-native.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "discovery-directory-")); roots.push(root);
  await mkdir(join(root, "workspace")); await mkdir(join(root, "outside"));
  await writeFile(join(root, "workspace/public.txt"), "public");
  await writeFile(join(root, "outside/SECRET.txt"), "SECRET");
  return root;
}

describe.skipIf(!discoveryBackendAvailable())("native pinned directory boundary", () => {
  it("uses the opened directory after its path becomes an outside symlink, then rejects publication", async () => {
    const root = await fixture();
    const workspace = join(root, "workspace");
    await expect(directory(workspace, async pinned => {
      await rename(workspace, join(root, "parked"));
      await symlink(join(root, "outside"), workspace);
      const names = [];
      for await (const name of pinned.names(100)) names.push(name);
      expect(names).toEqual(["public.txt"]);
      expect(await pinned.stat("public.txt")).toMatchObject({ file: true, nlink: 1 });
      await expect(pinned.stat("SECRET.txt")).rejects.toMatchObject({ code: "ENOENT" });
    })).rejects.toMatchObject({ code: "access_denied" });
  });

  it("refuses a symlink in the requested directory or any ancestor", async () => {
    const root = await fixture();
    await mkdir(join(root, "outside/subdir"));
    await symlink(join(root, "outside"), join(root, "alias"));
    for (const path of [join(root, "alias"), join(root, "alias/subdir")]) {
      let consumed = false;
      await expect(directory(path, async () => { consumed = true; })).rejects.toThrow();
      expect(consumed).toBe(false);
    }
  });
});

it.skipIf(!darwinDirectory)("bounds native enumeration and rejects nonlocal entry names and invalid handles", async () => {
  const root = await fixture();
  const handle = await open(join(root, "workspace"), constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
  try {
    for (const name of ["..", ".", "../outside/SECRET.txt", "/etc/passwd", "a\0b"]) expect(() => darwinDirectory!.stat(handle.fd, name)).toThrow("EINVAL");
    for (const fd of [-1, NaN, Infinity, 1.5]) expect(() => darwinDirectory!.names(fd, 1)).toThrow("EINVAL");
    for (const maximum of [0, 20002, NaN, Infinity, 1.5]) expect(() => darwinDirectory!.names(handle.fd, maximum)).toThrow("EINVAL");
    expect(darwinDirectory!.names(handle.fd, 1)).toHaveLength(1);
  } finally { await handle.close(); }
  expect(() => darwinDirectory!.stat(handle.fd, "public.txt")).toThrow("EINVAL");
});
