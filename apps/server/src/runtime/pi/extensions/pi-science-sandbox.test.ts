import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerSandbox from "./pi-science-sandbox.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("routes the Bash tool and direct Bash through sandbox jobs", async () => {
  vi.stubEnv("PI_SCIENCE_INTERNAL_TOKEN", "control-token");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let pollCount = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/api/jobs/conversation")) return new Response(JSON.stringify({ job_id: "job-1", status: "pending", stdout: "", stderr: "" }), { status: 200 });
    pollCount += 1;
    return new Response(JSON.stringify({ job_id: "job-1", status: "succeeded", return_code: 0, cursor: pollCount, lost: false, frames: [{ cursor: pollCount, stream: "stdout", data: Buffer.from(`ok-${pollCount}\n`).toString("base64") }] }), { status: 200 });
  }));

  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  registerSandbox({ registerTool: (tool: any) => tools.set(tool.name, tool), on: (name: string, handler: any) => events.set(name, handler) });
  const result = await tools.get("bash").execute("call-1", { command: "python --version" }, undefined, undefined, {
    cwd: "/workspace",
    model: { provider: "test", id: "model" },
    thinkingLevel: "high",
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
  });
  expect(result.content[0].text).toBe("ok-1\n");
  expect(result.details).toBeUndefined();
  const request = JSON.parse(String(calls[0]!.init.body));
  expect(request).toMatchObject({ command: "python --version", env: { PI_PROVIDER: "test", PI_MODEL: "model", PI_REASONING_LEVEL: "high", PI_SESSION_ID: "session-1" } });
  expect(new Headers(calls[0]!.init.headers).get("x-pi-science-internal-token")).toBe("control-token");

  const direct = events.get("user_bash")();
  let output = "";
  const directResult = await direct.operations.exec("pwd", "/workspace", { onData: (data: Buffer) => { output += data.toString(); } });
  expect(directResult.exitCode).toBe(0);
  expect(output).toBe("ok-2\n");
});

it("streams only new output while the job runs and retains Pi's truncation details", async () => {
  const updates: string[] = [];
  const large = `${"line\n".repeat(12_000)}`;
  let polls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/jobs/conversation")) return new Response(JSON.stringify({ job_id: "job-1", status: "pending" }));
    polls += 1;
    if (polls === 1) return new Response(JSON.stringify({ status: "running", cursor: 1, lost: false, frames: [{ cursor: 1, stream: "stdout", data: Buffer.from("starting\n").toString("base64") }] }));
    expect(String(url)).toContain("cursor=1");
    return new Response(JSON.stringify({ status: "succeeded", return_code: 0, cursor: 2, lost: false, frames: [{ cursor: 2, stream: "stdout", data: Buffer.from(large).toString("base64") }] }));
  }));
  let tool: any;
  registerSandbox({ registerTool: (value: any) => { tool = value; }, on: () => undefined });
  const result = await tool.execute("call", { command: "echo test" }, undefined, (update: any) => updates.push(update.content?.[0]?.text ?? ""), { cwd: "/workspace", sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined } });
  expect(updates.some((update) => update.includes("starting\n"))).toBe(true);
  expect(result.details?.truncation?.truncated).toBe(true);
  expect(result.details?.fullOutputPath).toBeTruthy();
  expect(result.content[0].text).toContain("Full output:");
});

it("does not pass runtime credentials to the sandbox job", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (String(url).includes("/api/jobs/conversation")) {
      expect(JSON.parse(String(init.body)).env).toEqual({});
      return new Response(JSON.stringify({ job_id: "job-1", status: "succeeded", return_code: 0, stdout: "", stderr: "" }), { status: 200 });
    }
    if (String(url).includes("/output")) return new Response(JSON.stringify({ status: "succeeded", return_code: 0, cursor: 0, lost: false, frames: [] }), { status: 200 });
    throw new Error("Unexpected request");
  }));
  const events = new Map<string, any>();
  registerSandbox({ registerTool: () => undefined, on: (name: string, handler: any) => events.set(name, handler) });
  await events.get("user_bash")().operations.exec("true", "/workspace", { onData: () => undefined, env: { PI_RUNTIME_CREDENTIAL_TEST: "secret", API_KEY: "secret" } });
});

it("cancels a job when abort arrives during creation", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    if (String(url).includes("/api/jobs/conversation")) {
      controller.abort();
      return new Response(JSON.stringify({ job_id: "job-1", status: "pending", stdout: "", stderr: "" }), { status: 200 });
    }
    return new Response(JSON.stringify({ job_id: "job-1", status: "cancelled", cursor: 0, lost: false, frames: [] }), { status: 200 });
  }));
  const events = new Map<string, any>();
  registerSandbox({ registerTool: () => undefined, on: (name: string, handler: any) => events.set(name, handler) });
  await expect(events.get("user_bash")().operations.exec("sleep 10", "/workspace", { onData: () => undefined, signal: controller.signal })).rejects.toThrow("aborted");
  expect(calls.some((call) => call.startsWith("DELETE "))).toBe(true);
});

it("blocks file tools from leaving the workspace or reading application metadata", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-science-file-gate-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-science-file-outside-"));
  try {
    vi.stubEnv("PI_WORKSPACE_DIR", workspace);
    await mkdir(join(workspace, ".pi-science"));
    await writeFile(join(workspace, "ok.txt"), "ok");
    await symlink(outside, join(workspace, "escape"));
    const events = new Map<string, any>();
    registerSandbox({ registerTool: () => undefined, on: (name: string, handler: any) => events.set(name, handler) });
    const check = events.get("tool_call");
    const ctx = { cwd: workspace };
    expect(await check({ toolName: "read", input: { path: "ok.txt" } }, ctx)).toBeUndefined();
    expect(await check({ toolName: "write", input: { path: "new/future.txt" } }, ctx)).toBeUndefined();
    expect(await check({ toolName: "read", input: { path: "../outside.txt" } }, ctx)).toMatchObject({ block: true });
    expect(await check({ toolName: "read", input: { path: "escape/secret.txt" } }, ctx)).toMatchObject({ block: true });
    expect(await check({ toolName: "edit", input: { path: ".pi-science/config.json" } }, ctx)).toMatchObject({ block: true });
    expect(await check({ toolName: "find", input: { pattern: "../*" } }, ctx)).toMatchObject({ block: true });
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
