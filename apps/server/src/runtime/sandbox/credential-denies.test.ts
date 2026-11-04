import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIAL_NAMES, expandCredentialDenies } from "./credential-denies.js";
import * as policy from "./policy.js";

let scratch: string;
beforeEach(async () => { scratch = await realpath(await mkdtemp(join(tmpdir(), "credential-denies-"))); });
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });
const scan = (roots: string[], denied: string[] = []) => expandCredentialDenies(roots, CREDENTIAL_NAMES, denied);

describe("credential denies", () => {
  it("finds deep credentials but not ordinary files", async () => {
    const nested = join(scratch, "a", "b"); await mkdir(nested, { recursive: true });
    for (const name of [".env", "credentials.json", "notes.txt"]) await writeFile(join(nested, name), "");
    expect(await scan([scratch])).toEqual({ paths: [join(nested, ".env"), join(nested, "credentials.json")], directories: 3, entries: 5 });
  });
  it("matches the .env. prefix including an empty suffix, not .envrc", async () => {
    for (const name of [".env.local", ".env.", ".envrc"]) await writeFile(join(scratch, name), "");
    expect((await scan([scratch])).paths).toEqual([join(scratch, ".env."), join(scratch, ".env.local")]);
    expect((await expandCredentialDenies([scratch], [".env"], [])).paths).toEqual([]);
  });
  it("denies a matched directory whole without reading its contents", async () => {
    const directory = join(scratch, ".pi-science"); await mkdir(directory); await writeFile(join(directory, ".env"), "");
    expect(await scan([scratch])).toEqual({ paths: [directory], directories: 1, entries: 1 });
  });
  it("follows a directory link and reports matches at their real locations", async () => {
    const root = join(scratch, "root"); const target = join(scratch, "target");
    await mkdir(root); await mkdir(target); await writeFile(join(target, ".env"), ""); await symlink(target, join(root, "alias"), "dir");
    expect((await scan([root])).paths).toEqual([join(target, ".env")]);
  });
  it("records a matched directory link and still scans its target", async () => {
    const root = join(scratch, "root"); const target = join(scratch, "target");
    await mkdir(root); await mkdir(target); await writeFile(join(target, ".env"), ""); await symlink(target, join(root, ".pi"), "dir");
    expect((await scan([root])).paths).toEqual([join(root, ".pi"), join(target, ".env")]);
  });
  it("terminates for self and ancestor directory links and unresolved links", async () => {
    const nested = join(scratch, "child"); await mkdir(nested);
    await symlink(scratch, join(scratch, "self"), "dir"); await symlink(scratch, join(nested, "parent"), "dir");
    await symlink(join(scratch, "missing"), join(scratch, "broken"), "dir");
    expect(await scan([scratch])).toEqual({ paths: [], directories: 2, entries: 4 });
  });
  it("shares real directory visits across roots, links, and cycles", async () => {
    const left = join(scratch, "left"); const right = join(scratch, "right"); await mkdir(left); await mkdir(right);
    await symlink(right, join(left, "right"), "dir"); await symlink(left, join(right, "left"), "dir"); await writeFile(join(right, ".env"), "");
    expect(await scan([left, right, left])).toEqual({ paths: [join(right, ".env")], directories: 2, entries: 3 });
  });
  it("prunes already-denied subtrees but ignores root and ancestor denies", async () => {
    const denied = join(scratch, "denied"); await mkdir(denied); await writeFile(join(denied, ".env"), ""); await writeFile(join(scratch, ".env"), "");
    const full = await scan([scratch]); const pruned = await scan([scratch], ["/", scratch, denied]);
    expect(full).toEqual({ paths: [join(scratch, ".env"), join(denied, ".env")], directories: 2, entries: 3 });
    expect(pruned).toEqual({ paths: [join(scratch, ".env")], directories: 1, entries: 2 });
  });
  it("prunes thousands of denied siblings without a linear containment scan per entry", async () => {
    const denied = Array.from({ length: 3000 }, (_, index) => join(scratch, `denied-${index}`));
    const deep = join(scratch, "open", "a", "b", "c");
    await Promise.all(denied.map((path) => mkdir(path))); await mkdir(deep, { recursive: true }); await writeFile(join(deep, ".env"), "");
    const original = policy.isWithin;
    const containment = vi.spyOn(policy, "isWithin").mockImplementation((ancestor, path) => {
      if (containment.mock.calls.length > denied.length + 10) throw new Error("Containment checks must not scale with denied paths per entry");
      return original(ancestor, path);
    });
    try {
      expect(await scan([scratch], denied)).toEqual({ paths: [join(deep, ".env")], directories: 5, entries: 3005 });
      expect(containment.mock.calls.length).toBeLessThanOrEqual(denied.length + 10);
    } finally { containment.mockRestore(); }
  });
  it("scans two independent roots in one call", async () => {
    const roots = [join(scratch, "one"), join(scratch, "two")];
    for (const root of roots) { await mkdir(root); await writeFile(join(root, ".env"), ""); }
    expect(await scan(roots)).toEqual({ paths: roots.map((root) => join(root, ".env")), directories: 2, entries: 2 });
  });
  it("finds credentials created after the first call", async () => {
    expect((await scan([scratch])).paths).toEqual([]); await writeFile(join(scratch, ".env"), "");
    expect((await scan([scratch])).paths).toEqual([join(scratch, ".env")]);
  });
  it("collapses descendants unconditionally even when a nested root is granted", async () => {
    const nested = join(scratch, ".pi", "allowed"); await mkdir(nested, { recursive: true }); await writeFile(join(nested, ".env"), "");
    expect((await scan([nested, scratch])).paths).toEqual([join(scratch, ".pi")]);
  });
  it("skips absent directories and denies other listing failures", async () => {
    const file = join(scratch, "file"); await writeFile(file, "");
    expect(await scan([file, join(scratch, "missing")])).toEqual({ paths: [file], directories: 0, entries: 0 });
  });
});
