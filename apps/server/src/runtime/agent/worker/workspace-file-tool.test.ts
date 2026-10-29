import { createReadTool, createWriteTool, createEditTool, BACKGROUND_CONTEXT, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { chmod, stat, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { workspaceFileTool } from "./workspace-file-tool.js";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
let root: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
it.skipIf(process.platform !== "linux")("permits workspace files and readonly skills but refuses private roots, escapes and linked reads/writes", async () => {
  await mkdir(resolve("../../.runtime"), { recursive: true }); root = await mkdtemp(join(resolve("../../.runtime"), "file-boundary-"));
  const cwd = join(root, "workspace"); const privateRoot = join(root, "private"); const skillRoot = join(root, "skills");
  for (const path of [cwd, privateRoot, skillRoot]) await mkdir(path, { mode: 0o700 });
  const secret = join(privateRoot, "labels.json"); await writeFile(secret, "SECRET"); await writeFile(join(skillRoot, "SKILL.md"), "protocol");
  const policy = join(privateRoot, "policy.json"); await writeFile(policy, JSON.stringify({ schemaVersion: 1, dependencyRoots: [], protectedRoots: [privateRoot] }), { mode: 0o600 }); vi.stubEnv("PI_SCIENCE_SANDBOX_READ_POLICY", policy);
  const env = new NodeExecutionEnv({ cwd }); const read = workspaceFileTool(createReadTool(), cwd, [skillRoot]); const write = workspaceFileTool(createWriteTool(), cwd, [skillRoot]);
  const invocation = { operationId: "op", invocationId: "call", turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} };
  const call = (tool: typeof read, path: string) => tool.execute("call", { path, content: "updated" }, () => {}, { env }, invocation, BACKGROUND_CONTEXT);
  await call(write, "research/study/evaluation.yaml"); expect(await readFile(join(cwd, "research/study/evaluation.yaml"), "utf8")).toBe("updated");
  expect(JSON.stringify(await call(read, join(skillRoot, "SKILL.md")))).toContain("protocol");
  await expect(call(write, join(skillRoot, "SKILL.md"))).rejects.toThrow("read-only");
  for (const tool of [read, write]) {
    await expect(call(tool, secret)).rejects.toThrow("Protected"); await expect(call(tool, "../escape")).rejects.toThrow("outside"); await expect(call(tool, ".pi-science/state.json")).rejects.toThrow("outside");
  }
  await symlink(secret, join(cwd, "alias.json"));
  await expect(call(read, "alias.json")).rejects.toThrow(); await expect(call(write, "alias.json")).rejects.toThrow();
  await symlink(privateRoot, join(cwd, "alias-dir")); await expect(call(write, "alias-dir/labels.json")).rejects.toThrow();
  expect(await readFile(secret, "utf8")).toBe("SECRET"); await env.cleanup(BACKGROUND_CONTEXT);
});

it.skipIf(process.platform !== "linux")("shares sensitive path denial across read/write/edit and permits only readonly Skill resources", async () => {
  await mkdir(resolve("../../.runtime"), { recursive: true }); root = await mkdtemp(join(resolve("../../.runtime"), "file-sensitive-"));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const skillRoot = join(cwd, ".pi/skills/example"); await mkdir(skillRoot, { recursive: true }); await writeFile(join(skillRoot, "SKILL.md"), "protocol");
  const env = new NodeExecutionEnv({ cwd });
  const tools = [createReadTool(), createWriteTool(), createEditTool()].map((tool) => workspaceFileTool(tool, cwd, [skillRoot]));
  const invocation = { operationId: "op", invocationId: "call", turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} };
  const call = (tool: typeof tools[number], path: string) => tool.execute("call", { path, content: "changed", edits: [{ oldText: "SECRET", newText: "changed" }] }, () => {}, { env }, invocation, BACKGROUND_CONTEXT);
  for (const path of [".env", ".env.local", ".ssh/id_rsa", ".aws/config", "credentials.json", "secrets.yaml", "nested/credentials-prod.json", "nested/.private/data.txt", "holdout/data.json", "final-tests/labels.json", "token.json", "cert.pem", "node_modules/package/config.json"]) {
    await mkdir(join(cwd, path, ".."), { recursive: true }); await writeFile(join(cwd, path), "SECRET");
    for (const tool of tools) await expect(call(tool, path)).rejects.toThrow("outside");
    expect(await readFile(join(cwd, path), "utf8")).toBe("SECRET");
  }
  await writeFile(join(cwd, "public.txt"), "SECRET"); await call(tools[2]!, "public.txt"); expect(await readFile(join(cwd, "public.txt"), "utf8")).toBe("changed");
  await symlink(join(cwd, ".ssh"), join(cwd, "alias"));
  await link(join(cwd, "credentials.json"), join(cwd, "innocent.json"));
  for (const tool of tools) for (const path of ["alias/id_rsa", "innocent.json"]) await expect(call(tool, path)).rejects.toThrow();
  expect(await readFile(join(cwd, "credentials.json"), "utf8")).toBe("SECRET");
  expect(await readFile(join(cwd, ".ssh/id_rsa"), "utf8")).toBe("SECRET");
  expect(JSON.stringify(await call(tools[0]!, join(skillRoot, "SKILL.md")))).toContain("protocol");
  for (const tool of tools.slice(1)) await expect(call(tool, join(skillRoot, "SKILL.md"))).rejects.toThrow("read-only");
  await writeFile(join(skillRoot, "credentials.json"), "SECRET"); await expect(call(tools[0]!, join(skillRoot, "credentials.json"))).rejects.toThrow("outside");
  await env.cleanup(BACKGROUND_CONTEXT);
});

it.skipIf(process.platform !== "linux")("keeps complete checkpoint bytes on partial write, sync, rename and cancellation failures, then resumes from the committed ledger", async () => {
  await mkdir(resolve("../../.runtime"), { recursive: true }); root = await mkdtemp(join(resolve("../../.runtime"), "file-atomic-"));
  const cwd = join(root, "workspace"); await mkdir(cwd); const directory = join(cwd, "research/study"); await mkdir(directory, { recursive: true });
  const manifest = join(directory, "manifest.json"); const state = join(directory, "state.json");
  const oldBytes = JSON.stringify({ revision: 1, completed: ["experiment-one"] }); const newBytes = JSON.stringify({ revision: 2, completed: ["experiment-one", "experiment-two"] });
  const env = new NodeExecutionEnv({ cwd }); const write = workspaceFileTool(createWriteTool(), cwd, []);
  const invocation = { operationId: "op", invocationId: "call", turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} };
  const call = (path: string, content: string, signal?: AbortSignal) => write.execute("call", { path, content }, () => {}, { env }, invocation, { ...BACKGROUND_CONTEXT, ...(signal ? { abortSignal: signal } : {}) });
  const actualOpen = vi.mocked(fs.open).getMockImplementation()!;
  for (const failure of ["partial-write", "sync", "rename", "abort", "after-commit"] as const) {
    await writeFile(manifest, oldBytes); const controller = new AbortController();
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      if (String(args[0]).includes(".pi-write-")) {
        if (failure === "partial-write") vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => { await handle.write("{"); throw new Error("injected partial write"); });
        if (failure === "sync") vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("injected sync"));
        if (failure === "abort") vi.spyOn(handle, "sync").mockImplementationOnce(async () => { controller.abort(new Error("injected cancellation")); });
      } else if (failure === "after-commit") vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("injected directory sync"));
      return handle;
    });
    if (failure === "rename") vi.mocked(fs.rename).mockRejectedValueOnce(new Error("injected rename"));
    await expect(call(manifest, newBytes, controller.signal)).rejects.toThrow(/injected/);
    expect(await readFile(manifest, "utf8")).toBe(failure === "after-commit" ? newBytes : oldBytes);
    expect(await readdir(directory)).toEqual(["manifest.json"]);
    vi.mocked(fs.open).mockImplementation(actualOpen); vi.restoreAllMocks();
  }
  const edit = workspaceFileTool(createEditTool(), cwd, []);
  await writeFile(manifest, oldBytes); vi.mocked(fs.rename).mockRejectedValueOnce(new Error("interrupted edit"));
  await expect(edit.execute("edit", { path: manifest, edits: [{ oldText: oldBytes, newText: newBytes }] }, () => {}, { env }, invocation, BACKGROUND_CONTEXT)).rejects.toThrow("interrupted edit");
  expect(await readFile(manifest, "utf8")).toBe(oldBytes);
  await chmod(manifest, 0o640); await call(manifest, newBytes); expect((await stat(manifest)).mode & 0o777).toBe(0o640); await writeFile(state, '{"manifest_revision":1}');
  vi.mocked(fs.rename).mockRejectedValueOnce(new Error("interrupted state checkpoint"));
  await expect(call(state, '{"manifest_revision":2}')).rejects.toThrow("interrupted");
  const read = workspaceFileTool(createReadTool(), cwd, []);
  const resumed = await read.execute("resume", { path: manifest }, () => {}, { env }, invocation, BACKGROUND_CONTEXT);
  expect(JSON.stringify(resumed)).toContain("experiment-two");
  expect(JSON.parse(await readFile(state, "utf8")).manifest_revision).toBe(1);
  await call(state, '{"manifest_revision":2}'); expect(JSON.parse(await readFile(manifest, "utf8")).revision).toBe(2);
  await env.cleanup(BACKGROUND_CONTEXT);
});

it("denies native hardlink aliases to sensitive files through read/write/edit", async () => {
  await mkdir(resolve("../../.runtime"), { recursive: true }); root = await mkdtemp(join(resolve("../../.runtime"), "native-file-boundary-"));
  const cwd = join(root, "workspace"); const skillRoot = join(cwd, ".pi/skills/example"); await mkdir(skillRoot, { recursive: true });
  await writeFile(join(cwd, "public.txt"), "public"); await writeFile(join(skillRoot, "SKILL.md"), "protocol");
  const secret = join(cwd, ".env"); await writeFile(secret, "SECRET"); await link(secret, join(cwd, "innocent.txt"));
  const env = new NodeExecutionEnv({ cwd });
  const invocation = { operationId: "op", invocationId: "call", turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} };
  const tools = [createReadTool(), createWriteTool(), createEditTool()].map((tool) => workspaceFileTool(tool, cwd, [skillRoot]));
  const call = (tool: typeof tools[number], path: string) => tool.execute("call", { path, content: "changed", edits: [{ oldText: "SECRET", newText: "changed" }] }, () => {}, { env }, invocation, BACKGROUND_CONTEXT);
  try {
    expect(JSON.stringify(await call(tools[0]!, "public.txt"))).toContain("public");
    expect(JSON.stringify(await call(tools[0]!, join(skillRoot, "SKILL.md")))).toContain("protocol");
    for (const tool of tools) {
      await expect(call(tool, ".env")).rejects.toThrow("outside");
      await expect(call(tool, "innocent.txt")).rejects.toThrow("single-link");
    }
    await expect(call(tools[1]!, join(skillRoot, "SKILL.md"))).rejects.toThrow("read-only");
    expect(await readFile(secret, "utf8")).toBe("SECRET");
    expect(await readFile(join(cwd, "innocent.txt"), "utf8")).toBe("SECRET");
  } finally { await env.cleanup(BACKGROUND_CONTEXT); }
});

it.skipIf(process.platform !== "darwin")("writes through the macOS sandbox into a temporary workspace", async () => {
  root = await mkdtemp(join(tmpdir(), "pi-file-tool-"));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const env = new NodeExecutionEnv({ cwd }); const write = workspaceFileTool(createWriteTool(), cwd, []);
  const invocation = { operationId: "op", invocationId: "call", turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} };
  await write.execute("call", { path: "research/report.md", content: "sandboxed write" }, () => {}, { env }, invocation, BACKGROUND_CONTEXT);
  expect(await readFile(join(cwd, "research/report.md"), "utf8")).toBe("sandboxed write");
  await env.cleanup(BACKGROUND_CONTEXT);
}, 120_000);
