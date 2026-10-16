import { mkdir, mkdtemp, writeFile, link, symlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { readRegularFile } from "./file-read.js";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
let root: string;
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }); });
it.skipIf(process.platform !== "linux")("reads bounded regular bytes and refuses hardlinks, aliases and linked parents", async () => {
  await mkdir(resolve("../../.runtime"), { recursive: true }); root = await mkdtemp(join(resolve("../../.runtime"), "regular-read-"));
  const file = join(root, "file.txt"); await writeFile(file, "safe"); expect((await readRegularFile(file, 4)).toString()).toBe("safe");
  await expect(readRegularFile(file, 3)).rejects.toThrow("bounded"); await symlink(file, join(root, "alias")); await expect(readRegularFile(join(root, "alias"), 4)).rejects.toThrow();
  await symlink(root, join(root, "parent")); await expect(readRegularFile(join(root, "parent/file.txt"), 4)).rejects.toThrow();
  await link(file, join(root, "hard")); await expect(readRegularFile(file, 4)).rejects.toThrow("single-link");
});

it("reads bounded regular files and rejects hardlink aliases on the native platform", async () => {
  await mkdir(resolve("../../.runtime"), { recursive: true }); root = await mkdtemp(join(resolve("../../.runtime"), "native-read-"));
  const secret = join(root, ".env"); const alias = join(root, "innocent.txt"); await writeFile(secret, "SECRET");
  expect((await readRegularFile(secret, 6)).toString()).toBe("SECRET");
  await expect(readRegularFile(secret, 5)).rejects.toThrow("bounded");
  await link(secret, alias);
  await expect(readRegularFile(alias, 16)).rejects.toThrow("single-link");
  await expect(readRegularFile(secret, 16)).rejects.toThrow("single-link");
});

it("revalidates the native descriptor when a hardlink appears during open or read", async () => {
  await mkdir(resolve("../../.runtime"), { recursive: true }); root = await mkdtemp(join(resolve("../../.runtime"), "native-race-"));
  // Exercise the native fallback locally too; native CI uses the actual OS.
  if (process.platform === "linux") vi.stubGlobal("process", new Proxy(process, { get(target, key, receiver) { return key === "platform" ? "darwin" : Reflect.get(target, key, receiver); } }));
  const actualOpen = vi.mocked(fs.open).getMockImplementation()!;
  for (const phase of ["open", "read"]) {
    const file = join(root, `${phase}.txt`); const alias = join(root, `${phase}-alias`); await writeFile(file, "SECRET");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args);
      if (phase === "open") await link(file, alias);
      else { const read = handle.read.bind(handle); vi.spyOn(handle, "read").mockImplementationOnce(async (...args: Parameters<typeof read>) => { const result = await read(...args); await link(file, alias); return result; }); }
      return handle;
    });
    await expect(readRegularFile(file, 16)).rejects.toThrow(phase === "open" ? "single-link" : "changed during capture");
  }
});
