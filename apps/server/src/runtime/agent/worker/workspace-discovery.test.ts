import { execFileSync, spawn } from "node:child_process";
import { chmod, unlink, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import * as safeRead from "../../sandbox/file-read.js";
import { discover, discoveryBackendAvailable, discoveryPath } from "./workspace-discovery.js";
import { workspaceDiscoveryTools } from "./workspace-discovery-tools.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function workspace() { const root = await mkdtemp(join(await import("node:fs/promises").then((fs) => fs.realpath(tmpdir())), "discovery-")); roots.push(root); return root; }
async function put(root: string, path: string, text: string | Buffer) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text); }
const run = (root: string, operation: "ls" | "glob" | "grep", input = {}) => discover(operation, root, { limit: 100, ...input });

describe.skipIf(!discoveryBackendAvailable())("workspace discovery on real Linux descriptors", () => {
  it("lists one level, sorts paths, preserves Unicode, and bounds results", async () => {
    const root = await workspace();
    await put(root, "z.csv", "x"); await put(root, "a/data.csv", "x"); await put(root, "中文 空格.csv", "x");
    expect((await run(root, "ls")).details.result).toEqual({ entries: [{ path: "a/", type: "directory" }, { path: "z.csv", type: "file" }, { path: "中文 空格.csv", type: "file" }], limit: 100, truncated: false });
    expect((await run(root, "ls", { limit: 1 })).details.result).toMatchObject({ entries: [{ path: "a/" }], truncated: true, truncationReason: "limit" });
    await mkdir(join(root, "empty")); expect((await run(root, "ls", { path: "empty" })).details.result.entries).toEqual([]);
  });
  it("supports globstar, braces, classes, nested ignores and explicit narrower paths", async () => {
    const root = await workspace();
    for (const name of ["a.csv", "nested/b.csv", "nested/c.tsv", "nested/skip.csv", "nested/deep/also.csv", "ignored/private.csv"]) await put(root, name, "data");
    await put(root, ".gitignore", "ignored/\nnested/*.csv\n");
    await put(root, "nested/.gitignore", "!b.csv\ndeep/\n");
    expect((await run(root, "glob", { pattern: "**/*.{csv,tsv}" })).details.result.files).toEqual(["a.csv", "nested/b.csv", "nested/c.tsv"]);
    expect((await run(root, "glob", { path: "nested", pattern: "[bc].*" })).details.result.files).toEqual(["nested/b.csv", "nested/c.tsv"]);
    expect((await run(root, "glob", { path: "ignored", pattern: "**/*" })).details.result.files).toEqual([]);
    expect((await run(root, "grep", { path: "nested/skip.csv", pattern: "data" })).details.result.matches).toEqual([]);
  });
  it("searches regex/literals, case, file filters and single files without duplicate lines", async () => {
    const root = await workspace(); await put(root, "data/α.txt", "first\nAlpha Alpha\na.b\nacb\n");
    expect((await run(root, "grep", { pattern: "alpha|first", ignoreCase: true, glob: "**/*.txt" })).details.result.matches).toEqual([
      { path: "data/α.txt", line: 1, text: "first" }, { path: "data/α.txt", line: 2, text: "Alpha Alpha" },
    ]);
    expect((await run(root, "grep", { pattern: "a.b", literal: true, path: "data/α.txt" })).details.result.matches).toEqual([{ path: "data/α.txt", line: 3, text: "a.b" }]);
    expect((await run(root, "grep", { pattern: "absent" })).details.result).toMatchObject({ matches: [], truncated: false });
    expect((await run(root, "grep", { pattern: ".", limit: 1 })).details.result).toMatchObject({ matches: [{ line: 1 }], truncated: true });
  });
  it.each(["single", "recursive"] as const)("reports unreadable files as errors in %s grep", async (scope) => {
    const root = await workspace(); await put(root, "a.txt", "matching content");
    await chmod(join(root, "a.txt"), 0);
    try { await expect(run(root, "grep", { path: scope === "single" ? "a.txt" : ".", pattern: "absent" })).rejects.toMatchObject({ code: "access_denied", message: "access_denied" }); }
    finally { await chmod(join(root, "a.txt"), 0o600); }
  });
  it.each(["single", "recursive"] as const)("reports files removed before capture in %s grep", async (scope) => {
    const root = await workspace(); await put(root, "a.txt", "matching content");
    const original = safeRead.readRegularFile; const target = join(root, "a.txt");
    vi.spyOn(safeRead, "readRegularFile").mockImplementation(async (path, maximum) => {
      if (path === target) await unlink(target);
      return original(path, maximum);
    });
    await expect(run(root, "grep", { path: scope === "single" ? "a.txt" : ".", pattern: "absent" })).rejects.toMatchObject({ code: "not_found", message: "not_found" });
  });
  it.each(["single", "recursive"] as const)("sanitizes capture integrity and I/O failures in %s grep", async (scope) => {
    const root = await workspace(); await put(root, "a.txt", "matching content");
    const original = safeRead.readRegularFile;
    for (const failure of [Object.assign(new Error("I/O failure at /private/service-state"), { code: "EIO" }), new Error("File changed during capture")]) {
      vi.spyOn(safeRead, "readRegularFile").mockImplementation((path, maximum) => path === join(root, "a.txt") ? Promise.reject(failure) : original(path, maximum));
      await expect(run(root, "grep", { path: scope === "single" ? "a.txt" : ".", pattern: "absent" })).rejects.toMatchObject({ code: "access_denied", message: "access_denied" });
    }
  });
  it("hides sensitive names, protected roots, file and directory aliases, special files and hardlinks", async () => {
    const root = await workspace(); const outside = await workspace();
    await put(root, "public.txt", "safe"); await put(outside, "external.txt", "SECRET");
    for (const name of [".env", ".pi-science/private", ".pi/skills/info", "node_modules/a", "holdout/labels", "secrets.json", "private/secret"]) await put(root, name, "SECRET");
    const policy = join(outside, "policy.json"); await writeFile(policy, JSON.stringify({ schemaVersion: 1, dependencyRoots: [], protectedRoots: [join(root, "private")] }), { mode: 0o600 });
    vi.stubEnv("PI_SCIENCE_SANDBOX_READ_POLICY", policy);
    await symlink(outside, join(root, "alias")); await symlink(join(outside, "external.txt"), join(root, "alias.txt")); await link(join(outside, "external.txt"), join(root, "hard.txt"));
    execFileSync("mkfifo", [join(root, "pipe")]);
    for (const operation of ["ls", "glob", "grep"] as const) {
      const result = await run(root, operation, { pattern: operation === "glob" ? "**/*" : "SECRET" });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/SECRET|private|alias|hard.txt|pipe|holdout|node_modules|\.env|\.pi/);
      expect(serialized).not.toContain(root);
    }
    for (const path of [".env", "holdout", "private", "alias", "alias.txt", "hard.txt"]) await expect(run(root, "grep", { path, pattern: "SECRET" })).rejects.toThrow("access_denied");
    expect(await readFile(join(outside, "external.txt"), "utf8")).toBe("SECRET");
  });
  it("skips binary, invalid UTF-8 and oversized files, marks incomplete scanning", async () => {
    const root = await workspace(); await put(root, "binary.txt", Buffer.from("SECRET\0")); await put(root, "invalid.txt", Buffer.from([0xff, 0xfe]));
    expect((await run(root, "grep", { pattern: "." })).details.result).toMatchObject({ matches: [], truncated: false });
    await put(root, "big.txt", Buffer.alloc(8 * 1024 * 1024 + 1, 65));
    expect((await run(root, "grep", { pattern: "." })).details.result).toMatchObject({ matches: [], truncated: true, truncationReason: "scan_budget" });
  });
  it("enforces the aggregate captured-byte budget even for skipped binary files", async () => {
    const root = await workspace(); const bytes = Buffer.alloc(8 * 1024 * 1024);
    for (let file = 0; file < 9; file++) await put(root, `${file}.dat`, bytes);
    await expect(run(root, "grep", { pattern: "absent" })).rejects.toThrow("resource_limit");
  });
  it("sanitizes control sequences, caps Unicode lines and complete JSON output bytes", async () => {
    const root = await workspace(); await put(root, "a.txt", ("\x1b[31m" + "界".repeat(900) + "\x1b[0m\r\n").repeat(150));
    const result = await run(root, "grep", { pattern: "界", limit: 200 });
    expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(64 * 1024);
    expect(result.details.result).toMatchObject({ truncated: true, truncationReason: "bytes" });
    expect(result.details.result.matches![0]!.text).toBe("界".repeat(512));
  });
  it("rejects malformed patterns and never interprets shell strings or option prefixes", async () => {
    const root = await workspace(); await put(root, "a.txt", "-x '$();'\n");
    expect((await run(root, "grep", { pattern: "-x '$();'", literal: true })).details.result.matches).toHaveLength(1);
    for (const pattern of ["(", "(?<=a)b", "(a)\\1"]) await expect(run(root, "grep", { pattern })).rejects.toThrow("unsupported_pattern");
    for (const pattern of ["[", "!(foo)"]) await expect(run(root, "glob", { pattern })).rejects.toThrow("unsupported_pattern");
    await expect(run(root, "glob", { pattern: "../*" })).rejects.toThrow("invalid_input");
    await put(root, "adversarial.txt", "a".repeat(100_000) + "!");
    expect((await run(root, "grep", { pattern: "(a+)+$" })).details.result.matches).toEqual([]);
  });
  it("enforces strict schemas and worker concurrency before I/O", async () => {
    const root = await workspace(); const tools = workspaceDiscoveryTools({ cwd: root }); const env = new NodeExecutionEnv({ cwd: root });
    const invocation = { operationId: "op", invocationId: "call", turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} };
    const call = (name: string, args: unknown) => tools.find((tool) => tool.name === name)!.execute("call", args, () => {}, { env }, invocation, BACKGROUND_CONTEXT);
    try {
      for (const [name, args] of [["ls", { limit: 0 }], ["ls", { limit: 501 }], ["ls", { extra: true }], ["glob", { pattern: "" }], ["grep", { pattern: "x".repeat(257) }], ["grep", { pattern: "x", literal: 1 }]] as const) await expect(call(name, args)).rejects.toThrow("invalid_input");
      const results = await Promise.allSettled([call("ls", {}), call("ls", {}), call("ls", {})]);
      expect(results.filter((entry) => entry.status === "rejected")).toHaveLength(1);
      expect(results[2]).toMatchObject({ status: "rejected", reason: { code: "resource_limit" } });
    } finally { await env.cleanup(BACKGROUND_CONTEXT); }
  });
  it("cancels, times out and refuses invalid operator execution modes", async () => {
    const root = await workspace(); const controller = new AbortController(); controller.abort();
    await expect(discover("ls", root, { limit: 1 }, controller.signal)).rejects.toThrow("cancelled");
    await put(root, "many.txt", "data\n".repeat(100_000));
    const active = new AbortController(); const pending = discover("grep", root, { pattern: "absent", limit: 1 }, active.signal); setTimeout(() => active.abort(), 5);
    await expect(pending).rejects.toThrow("cancelled");
    const clock = vi.spyOn(performance, "now"); clock.mockReturnValueOnce(0).mockReturnValue(6000);
    await expect(run(root, "ls")).rejects.toThrow("timeout"); clock.mockRestore();
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "invalid"); await expect(run(root, "ls")).rejects.toThrow("tool_unavailable");
  });
  it("bounds depth and raw enumeration work", async () => {
    const root = await workspace(); await put(root, "d/".repeat(22) + "a.txt", "x");
    await expect(run(root, "glob", { pattern: "**/*" })).rejects.toThrow("resource_limit");
    const wide = await workspace();
    for (let batch = 0; batch < 201; batch++) await Promise.all(Array.from({ length: 100 }, (_, index) => put(wide, `.hidden-${batch}-${index}`, "")));
    // Test the independent entry budget without racing the five-second budget
    // on heavily loaded CI. Timeout behavior has its own test above.
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try { await expect(run(wide, "ls", { limit: 1 })).rejects.toThrow("resource_limit"); }
    finally { clock.mockRestore(); }
  }, 30000);
  it("never follows directory swaps performed by an adversarial helper process", async () => {
    const root = await workspace(); const outside = await workspace();
    await put(root, "data/public.txt", "public"); await put(outside, "SECRET.txt", "SECRET");
    const helper = spawn(process.execPath, ["--input-type=module", "-e", `
      import { renameSync, symlinkSync, unlinkSync } from 'node:fs';
      const [root,outside]=process.argv.slice(1);
      process.send('ready');
      for (;;) { try { renameSync(root+'/data',root+'/parked'); symlinkSync(outside,root+'/data'); unlinkSync(root+'/data'); renameSync(root+'/parked',root+'/data'); } catch {} }
    `, root, outside], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    try {
      await new Promise<void>((done, reject) => { helper.once("message", () => done()); helper.once("error", reject); });
      for (let attempt = 0; attempt < 25; attempt++) {
        try { expect(JSON.stringify(await run(root, "glob", { pattern: "**/*" }))).not.toContain("SECRET"); }
        catch (error) { expect(error).toMatchObject({ code: expect.stringMatching(/access_denied|not_found/) }); }
        try { expect(JSON.stringify(await run(root, "grep", { pattern: "SECRET" }))).not.toContain("SECRET"); }
        catch (error) { expect(error).toMatchObject({ code: expect.stringMatching(/access_denied|not_found/) }); }
      }
    } finally {
      helper.kill("SIGKILL"); await new Promise<void>((done) => helper.once("exit", () => done()));
    }
  }, 20000);
});

it.each(["../outside", "/tmp/a", "C:\\Users\\x", "C:relative", "\\\\server\\share", "a/../b", "a\0b"])("rejects cross-platform path escape %j", (input) => {
  expect(() => discoveryPath(resolve("workspace"), input)).toThrow("invalid_input");
});
it.skipIf(discoveryBackendAvailable())("fails closed on unverified platforms", async () => {
  await expect(discover("ls", resolve("workspace"), { limit: 1 })).rejects.toThrow("tool_unavailable");
});
