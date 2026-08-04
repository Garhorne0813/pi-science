import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationEventHub } from "../events/conversation-event-hub.js";
import { NodeSessionService } from "./node-session-service.js";
import { ProjectReviewService } from "../../project-review/service.js";
import { parseReviewResult, type ReviewRunRequest, type ReviewRunResult, type ReviewSubagentRunner } from "../../project-review/types.js";

const cleanup: string[] = [];
const original = { home: process.env.PI_SCIENCE_HOME, cli: process.env.PI_CLI_PATH, node: process.env.PI_NODE_PATH, timeout: process.env.PI_SCIENCE_RPC_TIMEOUT_MS, delay: process.env.PI_SCIENCE_RECONCILE_DELAY_MS, deadline: process.env.PI_SCIENCE_RECONCILE_DEADLINE_MS, idle: process.env.PI_SCIENCE_IDLE_RUNTIME_MS, mode: process.env.FAKE_PI_MODE, piMode: process.env.PI_SCIENCE_PI_MODE };

beforeEach(async () => {
  const root = join(tmpdir(), `pi-science-node-service-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(root);
  await mkdir(root, { recursive: true });
  const script = join(root, "fake-pi.mjs");
  await writeFile(script, [
    'import fs from "node:fs";',
    'if (process.env.FAKE_PI_FAIL_START_FILE && fs.existsSync(process.env.FAKE_PI_FAIL_START_FILE)) { process.stderr.write("forced startup failure\\n"); process.exit(1); }',
    'import readline from "node:readline";',
    'const args = process.argv.slice(2);',
    'if (process.env.FAKE_PI_ARGS_LOG) fs.writeFileSync(process.env.FAKE_PI_ARGS_LOG, JSON.stringify(args));',
    'if (process.env.FAKE_PI_ENV_LOG) fs.writeFileSync(process.env.FAKE_PI_ENV_LOG, JSON.stringify({ PATH: process.env.PATH, VIRTUAL_ENV: process.env.VIRTUAL_ENV, PIP_REQUIRE_VIRTUALENV: process.env.PIP_REQUIRE_VIRTUALENV, npm_config_prefix: process.env.npm_config_prefix }));',
    'const sessionArg = args.indexOf("--session");',
    'let sessionId = sessionArg >= 0 ? JSON.parse(fs.readFileSync(args[sessionArg + 1], "utf8").split("\\n")[0]).id : `fresh-${process.pid}`;',
    'let counter = 0;',
    'let stateRequests = 0;',
    'let busy = false;',
    'let modelProvider = "openrouter";',
    'let modelId = "openai/gpt-5.1";',
    'let thinking = "high";',
    'const starts = process.env.FAKE_PI_STARTS;',
    'let startNumber = 1;',
    'if (starts) { try { startNumber = Number(fs.readFileSync(starts, "utf8")) + 1; } catch {} fs.writeFileSync(starts, String(startNumber)); }',
    'const log = process.env.FAKE_PI_LOG;',
    'const input = readline.createInterface({ input: process.stdin });',
    'function respond(request, extra = {}) { process.stdout.write(JSON.stringify({ id: request.id, success: true, ...extra }) + "\\n"); }',
    'input.on("line", (line) => {',
    '  const request = JSON.parse(line);',
    '  if (log) fs.appendFileSync(log, JSON.stringify(request) + "\\n");',
    '  if (!request.id) return;',
    '  if (request.type === "get_state") { stateRequests++; if (process.env.FAKE_PI_MODE === "restart-fail-once" && startNumber === 2) return; if (process.env.FAKE_PI_MODE === "new-session-state-fails" && sessionId.startsWith("generated-")) return respond(request, { success: false, code: "state_failed", error: "state unavailable" }); if (Number(process.env.FAKE_PI_FAIL_STATE_AFTER || 0) > 0 && stateRequests > Number(process.env.FAKE_PI_FAIL_STATE_AFTER)) return respond(request, { success: false, code: "state_failed", error: "state unavailable" }); const orbitBusyOnly = process.env.FAKE_PI_MODE === "orbit-busy-without-agent-start"; return respond(request, { data: { sessionId, busy, isStreaming: orbitBusyOnly ? false : busy, isCompacting: false, pendingMessageCount: 0, model: { provider: modelProvider, id: modelId }, thinkingLevel: thinking } }); }',
    '  if (request.type === "switch_session") { sessionId = JSON.parse(fs.readFileSync(request.sessionPath, "utf8").split("\\n")[0]).id; return respond(request); }',
    '  if (request.type === "new_session" || request.type === "clone" || request.type === "fork") { sessionId = `generated-${++counter}-${process.pid}`; return respond(request); }',
    '  if (request.type === "prompt") { if (process.env.FAKE_PI_MODE === "prompt-timeout") return; busy = true; respond(request); if (process.env.FAKE_PI_MODE !== "orbit-busy-without-agent-start") process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n"); return; }',
    '  if (request.type === "compact") { if (process.env.FAKE_PI_MODE === "compact-timeout") return; return respond(request); }',
    '  if (request.type === "abort") { busy = false; respond(request); process.stdout.write(JSON.stringify({ type: "agent_settled", handledWithoutTurn: true }) + "\\n"); return; }',
    '  if (request.type === "get_commands") return process.env.FAKE_PI_MODE === "cancel-commands" ? respond(request, { data: { cancelled: true } }) : respond(request, { data: { commands: [{ name: "review", source: "skill" }] } });',
    '  if (request.type === "get_available_models") return respond(request, { data: { models: [{ provider: "openrouter", id: "openai/gpt-5.1", name: "GPT-5.1", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: null } }] } });',
    '  if (request.type === "get_session_stats") return respond(request, { data: { contextUsage: { tokens: 32000, contextWindow: 128000, percent: 25 } } });',
    '  if (request.type === "set_model") { modelProvider = request.provider; modelId = request.modelId; return respond(request); }',
    '  if (request.type === "set_thinking_level") { if (request.level === "ultra") return process.stdout.write(JSON.stringify({ id: request.id, success: false, code: "invalid_thinking", error: "unsupported thinking" }) + "\\n"); thinking = request.level; return respond(request); }',
    '  respond(request);',
    '});',
  ].join("\n"), "utf8");
  process.env.PI_SCIENCE_HOME = join(root, "data");
  process.env.PI_CLI_PATH = script;
  process.env.PI_NODE_PATH = process.execPath;
  process.env.PI_SCIENCE_PI_MODE = "rpc";
  process.env.FAKE_PI_LOG = join(root, "rpc.jsonl");
  process.env.FAKE_PI_ARGS_LOG = join(root, "pi-args.json");
  process.env.FAKE_PI_STARTS = join(root, "starts.txt");
  // Leave enough headroom for spawning the fake Pi under parallel CI load.
  // Timeout-specific tests still complete quickly because the fake process is
  // already running before the intentionally unanswered RPC is sent.
  process.env.PI_SCIENCE_RPC_TIMEOUT_MS = "500";
  process.env.PI_SCIENCE_RECONCILE_DELAY_MS = "20";
  process.env.PI_SCIENCE_RECONCILE_DEADLINE_MS = "700";
  process.env.PI_SCIENCE_IDLE_RUNTIME_MS = "0";
  process.env.FAKE_PI_FAIL_START_FILE = join(root, "fail-start");
});

afterEach(async () => {
  process.env.PI_SCIENCE_HOME = original.home;
  process.env.PI_CLI_PATH = original.cli;
  process.env.PI_NODE_PATH = original.node;
  process.env.PI_SCIENCE_RPC_TIMEOUT_MS = original.timeout;
  process.env.PI_SCIENCE_RECONCILE_DELAY_MS = original.delay;
  process.env.PI_SCIENCE_RECONCILE_DEADLINE_MS = original.deadline;
  process.env.PI_SCIENCE_IDLE_RUNTIME_MS = original.idle;
  process.env.FAKE_PI_MODE = original.mode;
  if (original.piMode === undefined) delete process.env.PI_SCIENCE_PI_MODE;
  else process.env.PI_SCIENCE_PI_MODE = original.piMode;
  delete process.env.FAKE_PI_LOG;
  delete process.env.FAKE_PI_ARGS_LOG;
  delete process.env.FAKE_PI_STARTS;
  delete process.env.FAKE_PI_FAIL_STATE_AFTER;
  delete process.env.FAKE_PI_FAIL_START_FILE;
  delete process.env.FAKE_PI_ENV_LOG;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function workspaceWithSessions(...ids: string[]): Promise<string> {
  const cwd = join(tmpdir(), `pi-science-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(cwd);
  const directory = join(cwd, ".pi-science", "sessions");
  await mkdir(directory, { recursive: true });
  for (const id of ids) await writeFile(join(directory, `${id}.jsonl`), `${JSON.stringify({ type: "session", id, cwd, timestamp: new Date().toISOString() })}\n`, "utf8");
  return realpath(cwd);
}

const passthroughEnvironments = {
  async environment(_cwd: string, inherited: NodeJS.ProcessEnv = process.env) { return { ...inherited }; },
};

function testService(): NodeSessionService {
  return new NodeSessionService(undefined, undefined, undefined, passthroughEnvironments);
}

describe("Node session lifecycle", () => {
  it("fails fast when the Pi runtime is missing without provisioning the workspace environment", async () => {
    const environment = vi.fn(async () => ({ ...process.env }));
    const service = new NodeSessionService(undefined, undefined, undefined, { environment });
    const cwd = await workspaceWithSessions("missing-runtime");
    delete process.env.PI_CLI_PATH;

    await expect(service.resume("missing-runtime", cwd)).resolves.toMatchObject({ success: false, code: "spawn_failed" });
    expect(environment).not.toHaveBeenCalled();
  });

  it("starts the agent inside the workspace package environment", async () => {
    const service = new NodeSessionService();
    const cwd = await workspaceWithSessions("isolated-session");
    process.env.FAKE_PI_ENV_LOG = join(cwd, "agent-environment.json");

    await expect(service.resume("isolated-session", cwd)).resolves.toEqual({ success: true });

    const environment = JSON.parse(await readFile(process.env.FAKE_PI_ENV_LOG, "utf8"));
    expect(environment).toMatchObject({
      VIRTUAL_ENV: join(cwd, ".venv"),
      PIP_REQUIRE_VIRTUALENV: "1",
      npm_config_prefix: join(cwd, ".pi-science", "npm-global"),
    });
    expect(environment.PATH.split(delimiter)[0]).toBe(join(cwd, ".venv", process.platform === "win32" ? "Scripts" : "bin"));
    await service.shutdownAll();
  }, 30_000);

  it("switches atomically between persisted sessions", async () => {
    const service = testService();
    const cwd = await workspaceWithSessions("session-a", "session-b");
    await service.resume("session-a", cwd);
    await expect(service.state("session-a", cwd)).resolves.toMatchObject({
      id: "session-a",
      context_tokens: 32000,
      context_window: 128000,
      context_percent: 25,
      compaction_enabled: true,
    });
    await expect(service.state("session-b", cwd)).resolves.toMatchObject({ id: "session-b" });
    await service.resume("session-b", cwd);
    expect(service.activeCount).toBe(2);
    await expect(Promise.all([
      service.command("session-a", cwd, "prompt", { message: "a" }),
      service.command("session-b", cwd, "prompt", { message: "b" }),
    ])).resolves.toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true }),
    ]);
    await expect(service.state("session-a", cwd)).resolves.toMatchObject({ id: "session-a" });
    await service.shutdownAll();
  });

  it("keeps identical session IDs isolated across workspaces", async () => {
    process.env.PI_SCIENCE_RPC_TIMEOUT_MS = "1500";
    const service = testService();
    const first = await workspaceWithSessions("same-session");
    const second = await workspaceWithSessions("same-session");
    await expect(service.resume("same-session", first)).resolves.toEqual({ success: true });
    await expect(service.resume("same-session", second)).resolves.toEqual({ success: true });
    expect(service.activeCount).toBe(2);
    await expect(service.state("same-session", first)).resolves.toMatchObject({ id: "same-session", cwd: first });
    await expect(service.state("same-session", second)).resolves.toMatchObject({ id: "same-session", cwd: second });
    await service.shutdownAll();
  });

  it("reclaims an idle runtime without disrupting a subscribed conversation", async () => {
    process.env.PI_SCIENCE_IDLE_RUNTIME_MS = "30";
    const service = testService();
    const cwd = await workspaceWithSessions("session-idle", "session-subscribed");
    await service.resume("session-idle", cwd);
    for (let attempt = 0; attempt < 200 && service.activeCount > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(service.activeCount).toBe(0);

    await service.resume("session-subscribed", cwd);
    const unsubscribe = await conversationEventHub.subscribe(cwd, "session-subscribed", undefined, () => undefined, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(service.activeCount).toBe(1);
    unsubscribe();
    await service.shutdownAll();
  });

  it("creates consecutive blank sessions when no provider or model is configured", async () => {
    await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), JSON.stringify({ model: "", thinking: "off" }), "utf8");
    const service = testService();
    const cwd = await workspaceWithSessions();
    const first = await service.create({ cwd, config: { skills: [], extensions: [] } });
    const second = await service.create({ cwd, config: { skills: [], extensions: [] } });
    expect(first).toHaveProperty("id");
    expect(second).toHaveProperty("id");
    expect("id" in first && "id" in second ? second.id : "").not.toBe("id" in first ? first.id : "");
    await service.shutdownAll();
  });

  it("keeps auto-detected extensions when create receives empty config arrays", async () => {
    const service = testService();
    const cwd = await workspaceWithSessions();

    await expect(service.create({ cwd, config: { skills: [], extensions: [] } })).resolves.toHaveProperty("id");

    const args = JSON.parse(await readFile(process.env.FAKE_PI_ARGS_LOG!, "utf8")) as string[];
    expect(args).toContain("-e");
    expect(args).toContain(join(import.meta.dirname, "../pi/extensions/pi-science-ask-user-question-web.ts"));
    await service.shutdownAll();
  });

  it("keeps other sessions independent while a turn is active and deletes exactly one session", async () => {
    const service = testService();
    const cwd = await workspaceWithSessions("session-a", "session-b");
    await service.resume("session-a", cwd);
    await expect(service.command("session-a", cwd, "prompt", { message: "hold" })).resolves.toMatchObject({ success: true });
    const created = await service.create({ cwd, config: { skills: [], extensions: [] } });
    expect(created).toHaveProperty("id");
    expect(service.activeCount).toBe(2);
    await expect(service.command("session-a", cwd, "prompt", { message: "second" })).resolves.toMatchObject({ code: "busy" });
    await expect(service.delete("session-a", cwd)).resolves.toMatchObject({ code: "busy" });
    await service.command("session-a", cwd, "abort");
    await expect(service.delete("session-b", cwd)).resolves.toEqual({ success: true });
    await expect(service.state("session-a", cwd)).resolves.toMatchObject({ id: "session-a" });
    await service.shutdownAll();
  });

  it("preserves nested model IDs and supports commands, fork, and interaction notifications", async () => {
    const service = testService();
    const cwd = await workspaceWithSessions("session-a");
    await service.resume("session-a", cwd);
    await expect(service.availableModels(cwd)).resolves.toMatchObject({ data: { models: [expect.objectContaining({ id: "openai/gpt-5.1" })] } });
    await expect(service.configure("session-a", cwd, "openrouter/openai/gpt-5.1", "high")).resolves.toMatchObject({ success: true });
    await expect(service.command("session-a", cwd, "get_commands")).resolves.toMatchObject({ data: { commands: [{ name: "review" }] } });
    await expect(service.notify("session-a", cwd, "extension_ui_response", { id: "question-1", confirmed: true })).resolves.toMatchObject({ success: true });
    const forked = await service.fork("session-a", cwd);
    expect(forked.success).toBe(true);
    expect(forked.sessionId).toEqual(expect.any(String));
    expect(forked.sessionId).not.toBe("session-a");
    const log = await readFile(process.env.FAKE_PI_LOG!, "utf8");
    expect(log).toContain('"type":"set_model","provider":"openrouter","modelId":"openai/gpt-5.1"');
    expect(log).toContain('"type":"extension_ui_response","id":"question-1","confirmed":true');
    await service.shutdownAll();
  });

  it("activates a persisted session before loading command metadata", async () => {
    const service = testService();
    const cwd = await workspaceWithSessions("session-a");

    await expect(service.command("session-a", cwd, "get_commands")).resolves.toMatchObject({
      data: { commands: [{ name: "review", source: "skill" }] },
    });
    expect(service.activeCount).toBe(1);
    await service.shutdownAll();
  });

  it("reports configuration reload failures instead of silently succeeding", async () => {
    const service = testService();
    const cwd = await workspaceWithSessions("session-a");
    await expect(service.resume("session-a", cwd)).resolves.toEqual({ success: true });
    await writeFile(process.env.FAKE_PI_FAIL_START_FILE!, "fail", "utf8");
    await expect(service.reloadConfiguration()).rejects.toThrow(/process_exit|forced startup failure|pi process exited/i);
    await service.shutdownAll();
  });

  it("reconciles timed-out prompt and compact operations without leaving the workspace permanently busy", async () => {
    for (const mode of ["prompt-timeout", "compact-timeout"]) {
      process.env.FAKE_PI_MODE = mode;
      const service = testService();
      const cwd = await workspaceWithSessions(`session-${mode}`);
      await service.resume(`session-${mode}`, cwd);
      await expect(service.command(`session-${mode}`, cwd, mode.startsWith("prompt") ? "prompt" : "compact", { message: "test" })).resolves.toMatchObject({ code: "timeout" });
      await new Promise((resolve) => setTimeout(resolve, 130));
      await expect(service.create({ cwd, config: { skills: [], extensions: [] } })).resolves.toHaveProperty("id");
      await service.shutdownAll();
    }
  });

  it("uses Pi Orbit runtime busy state when the agent_start event is delayed", async () => {
    process.env.FAKE_PI_MODE = "orbit-busy-without-agent-start";
    const service = testService();
    const cwd = await workspaceWithSessions("session-orbit-busy");
    const publish = vi.spyOn(conversationEventHub, "publish");
    await service.resume("session-orbit-busy", cwd);

    await expect(service.command("session-orbit-busy", cwd, "prompt", { message: "test" })).resolves.toMatchObject({ success: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(publish).not.toHaveBeenCalledWith(cwd, "session-orbit-busy", expect.objectContaining({
      message: "The prompt was accepted but the Pi runtime did not start an agent turn.",
    }));
    await service.command("session-orbit-busy", cwd, "abort");
    publish.mockRestore();
    await service.shutdownAll();
  });

  it("rolls back a new session when configuration fails", async () => {
    const service = testService();
    const cwd = await workspaceWithSessions("session-a");
    await service.resume("session-a", cwd);
    await expect(service.create({ cwd, config: { model: "openrouter/openai/gpt-5.1", thinking: "ultra", skills: [], extensions: [] } })).resolves.toMatchObject({ code: "invalid_thinking" });
    await expect(service.state("session-a", cwd)).resolves.toMatchObject({ id: "session-a" });
    await service.shutdownAll();
  });

  it("does not execute a mutating command when preflight reconciliation fails", async () => {
    process.env.FAKE_PI_FAIL_STATE_AFTER = "1";
    const service = testService();
    const cwd = await workspaceWithSessions("session-a");
    await service.resume("session-a", cwd);
    await expect(service.fork("session-a", cwd)).resolves.toMatchObject({ success: false, code: "state_failed" });
    expect(await readFile(process.env.FAKE_PI_LOG!, "utf8")).not.toContain('"type":"clone"');
    await service.shutdownAll();
  });

  it("drops stale runtime indexes when a session-changing command cannot be confirmed", async () => {
    process.env.FAKE_PI_MODE = "new-session-state-fails";
    const service = testService();
    const cwd = await workspaceWithSessions("session-a");
    await service.resume("session-a", cwd);
    await expect(service.command("session-a", cwd, "new_session")).resolves.toMatchObject({ success: false, code: "state_failed" });
    expect(service.activeCount).toBe(0);

    process.env.FAKE_PI_MODE = "";
    await expect(service.state("session-a", cwd)).resolves.toMatchObject({ id: "session-a" });
    await service.shutdownAll();
  });

  it("cleans a failed restart handshake, restores the old session, and publishes blank replacements", async () => {
    const service = testService();
    const cwd = await workspaceWithSessions("session-a");
    process.env.FAKE_PI_MODE = "restart-fail-once";
    await service.resume("session-a", cwd);
    await expect(service.reloadConfiguration()).rejects.toThrow("timeout");
    await expect(service.state("session-a", cwd)).resolves.toMatchObject({ id: "session-a" });
    await service.shutdownAll();

    process.env.FAKE_PI_MODE = "";
    const blankService = testService();
    const blankCwd = await workspaceWithSessions();
    const publish = vi.spyOn(conversationEventHub, "publish");
    const created = await blankService.create({ cwd: blankCwd, config: { skills: [], extensions: [] } });
    expect("id" in created).toBe(true);
    await blankService.reloadConfiguration();
    expect(publish).toHaveBeenCalledWith(blankCwd, (created as { id: string }).id, expect.objectContaining({ type: "session.replaced" }));
    publish.mockRestore();
    await blankService.shutdownAll();
  });
});

class FakeReviewRunner implements ReviewSubagentRunner {
  calls: ReviewRunRequest[] = [];
  gate: Promise<void> = Promise.resolve();
  failure: Error | null = null;

  async run(request: ReviewRunRequest): Promise<ReviewRunResult> {
    this.calls.push(request);
    await this.gate;
    if (this.failure) throw this.failure;
    return { run_id: request.run_id, output: parseReviewResult(JSON.stringify([{ knowledge_type: "finding", title: `finding ${this.calls.length}`, summary: "A durable observation about the workspace." }])) };
  }

  async shutdown(): Promise<void> {}
}

async function workspaceWithConversation(sessionId: string): Promise<string> {
  const cwd = join(tmpdir(), `pi-science-auto-review-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(cwd);
  await mkdir(join(cwd, ".pi-science", "sessions"), { recursive: true });
  const rows = [
    JSON.stringify({ type: "session", id: sessionId, cwd, timestamp: new Date().toISOString() }),
    JSON.stringify({ type: "message", id: "message-0", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "why does the buffer drift?" }] } }),
    JSON.stringify({ type: "message", id: "message-1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "because it warms above 20C" }] } }),
  ];
  await writeFile(join(cwd, ".pi-science", "sessions", `${sessionId}.jsonl`), `${rows.join("\n")}\n`, "utf8");
  return realpath(cwd);
}

/** `policy.auto_review` ships off, so every test that expects the reviewer to fire opts in first. */
async function enableAutoReview(cwd: string): Promise<void> {
  await writeFile(join(cwd, ".pi-science", "project-state.json"), JSON.stringify({ items: [], proposals: [], project_versions: [], policy: { auto_review: true }, history: [] }), "utf8");
}

async function proposals(cwd: string): Promise<Array<Record<string, unknown>>> {
  try { return JSON.parse(await readFile(join(cwd, ".pi-science", "project-state.json"), "utf8")).proposals; }
  catch { return []; }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met before the timeout");
}

describe("automatic project review", () => {
  it("appends proposals once per settled turn and drops a settle while one is in flight", async () => {
    const runner = new FakeReviewRunner();
    const gate = { release: () => {} };
    runner.gate = new Promise<void>((resolve) => { gate.release = resolve; });
    const logged: string[] = [];
    const service = new NodeSessionService(undefined, undefined, undefined, passthroughEnvironments, new ProjectReviewService(runner));
    service.configureLogging((level, message) => { logged.push(`${level}:${message}`); });
    const cwd = await workspaceWithConversation("session-a");
    await enableAutoReview(cwd);
    await service.resume("session-a", cwd);

    await service.command("session-a", cwd, "abort");
    await waitFor(() => runner.calls.length === 1);
    await service.command("session-a", cwd, "abort");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runner.calls).toHaveLength(1);
    // Dropped before the reviewer is asked, so the workspace single-flight guard
    // never rejects and nothing is logged.
    expect(logged).toEqual([]);
    gate.release();
    await waitFor(async () => (await proposals(cwd)).length === 1);

    expect(runner.calls[0]).toMatchObject({ cwd, session_id: "session-a" });
    expect((await proposals(cwd))[0]).toMatchObject({ status: "pending", proposal_type: "knowledge", source: { session_id: "session-a" } });

    await service.command("session-a", cwd, "abort");
    await waitFor(async () => (await proposals(cwd)).length === 2);
    expect(runner.calls).toHaveLength(2);
    await service.shutdownAll();
  }, 15_000);

  it("does not run the reviewer when policy.auto_review is disabled", async () => {
    const runner = new FakeReviewRunner();
    const service = new NodeSessionService(undefined, undefined, undefined, passthroughEnvironments, new ProjectReviewService(runner));
    const cwd = await workspaceWithConversation("session-a");
    await writeFile(join(cwd, ".pi-science", "project-state.json"), JSON.stringify({ items: [], proposals: [], project_versions: [], policy: { auto_review: false }, history: [] }), "utf8");
    await service.resume("session-a", cwd);

    await service.command("session-a", cwd, "abort");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(runner.calls).toHaveLength(0);
    expect(await proposals(cwd)).toHaveLength(0);
    await service.shutdownAll();
  });

  it("does not run the reviewer on a workspace that never opted in", async () => {
    const runner = new FakeReviewRunner();
    const service = new NodeSessionService(undefined, undefined, undefined, passthroughEnvironments, new ProjectReviewService(runner));
    const cwd = await workspaceWithConversation("session-a");
    await service.resume("session-a", cwd);

    await service.command("session-a", cwd, "abort");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(runner.calls).toHaveLength(0);
    expect(await proposals(cwd)).toHaveLength(0);
    await service.shutdownAll();
  });

  it("logs a reviewer failure without poisoning the next turn", async () => {
    const runner = new FakeReviewRunner();
    runner.failure = new Error("Pi CLI is not configured");
    const logged: string[] = [];
    const service = new NodeSessionService(undefined, undefined, undefined, passthroughEnvironments, new ProjectReviewService(runner));
    service.configureLogging((level, message) => { logged.push(`${level}:${message}`); });
    const cwd = await workspaceWithConversation("session-a");
    await enableAutoReview(cwd);
    await service.resume("session-a", cwd);

    await service.command("session-a", cwd, "abort");
    await waitFor(() => logged.length === 1);
    expect(logged[0]).toContain("warn:automatic project review failed for session session-a");
    expect(logged[0]).toContain("Pi CLI is not configured");
    expect(await proposals(cwd)).toHaveLength(0);

    runner.failure = null;
    await service.command("session-a", cwd, "abort");
    await waitFor(async () => (await proposals(cwd)).length === 1);
    expect(await service.state("session-a", cwd)).toMatchObject({ id: "session-a" });
    await service.shutdownAll();
  });
});
