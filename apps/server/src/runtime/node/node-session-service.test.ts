import { mkdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationEventHub, conversationEventHub } from "../events/conversation-event-hub.js";
import type { SseEventRecord } from "../events/event-store.js";
import { NodeSessionService } from "./node-session-service.js";
import { loadDefaultPiConfig } from "../pi/pi-runtime-launch.js";
import { readJsonLines } from "../../storage/persistence.js";
import { ProjectReviewService } from "../../project-review/service.js";
import { parseReviewResult, type ReviewRunRequest, type ReviewRunResult, type ReviewSubagentRunner } from "../../project-review/types.js";

const cleanup: string[] = [];
const original = { home: process.env.PI_SCIENCE_HOME, cli: process.env.PI_CLI_PATH, node: process.env.PI_NODE_PATH, timeout: process.env.PI_SCIENCE_RPC_TIMEOUT_MS, delay: process.env.PI_SCIENCE_RECONCILE_DELAY_MS, deadline: process.env.PI_SCIENCE_RECONCILE_DEADLINE_MS, idle: process.env.PI_SCIENCE_IDLE_RUNTIME_MS, mode: process.env.FAKE_PI_MODE, piMode: process.env.PI_SCIENCE_PI_MODE, argsLog: process.env.FAKE_PI_ARGS_LOG, stateDelay: process.env.FAKE_PI_STATE_DELAY, activeProbe: process.env.FAKE_PI_ACTIVE_PROBE, agentStartDelay: process.env.FAKE_PI_AGENT_START_DELAY, watchdog: process.env.PI_SCIENCE_EVENT_WATCHDOG_MS, sessionFile: process.env.FAKE_PI_SESSION_FILE };

beforeEach(async () => {
  const root = join(tmpdir(), `pi-science-node-service-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(root);
  await mkdir(root, { recursive: true });
  const script = join(root, "fake-pi.mjs");
  await writeFile(script, [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'if (process.env.FAKE_PI_FAIL_START_FILE && fs.existsSync(process.env.FAKE_PI_FAIL_START_FILE)) { process.stderr.write("forced startup failure\\n"); process.exit(1); }',
    'import readline from "node:readline";',
    'const args = process.argv.slice(2);',
    'if (process.env.FAKE_PI_ARGS_LOG) fs.appendFileSync(process.env.FAKE_PI_ARGS_LOG, JSON.stringify(args) + "\\n");',
    'if (process.env.FAKE_PI_ENV_LOG) fs.writeFileSync(process.env.FAKE_PI_ENV_LOG, JSON.stringify({ PATH: process.env.PATH, VIRTUAL_ENV: process.env.VIRTUAL_ENV, PIP_REQUIRE_VIRTUALENV: process.env.PIP_REQUIRE_VIRTUALENV, npm_config_prefix: process.env.npm_config_prefix }));',
    'const sessionArg = args.indexOf("--session");',
    'let sessionId = sessionArg >= 0 ? JSON.parse(fs.readFileSync(args[sessionArg + 1], "utf8").split("\\n")[0]).id : `fresh-${process.pid}`;',
    'let counter = 0;',
    'let stateRequests = 0;',
    'let reconciliationProbes = 0;',
    'let promptAccepted = false;',
    'let agentStartNotified = false;',
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
    '  if (request.type === "get_state" && process.env.FAKE_PI_MODE === "idle-active-idle") { stateRequests++; const probe = promptAccepted ? reconciliationProbes++ : -1; const activeProbe = Number(process.env.FAKE_PI_ACTIVE_PROBE || 4); const active = promptAccepted && probe >= 0 && probe % (activeProbe + 1) === activeProbe; if (log) fs.appendFileSync(log, JSON.stringify({ type: "state_probe", phase: promptAccepted ? "reconciliation" : "preflight", probe, active }) + "\\n"); return respond(request, { data: { sessionId, busy: active, isStreaming: active, isCompacting: false, pendingMessageCount: 0, model: { provider: modelProvider, id: modelId }, thinkingLevel: thinking } }); }',
    '  if (request.type === "get_state" && process.env.FAKE_PI_MODE === "late-agent-start" && promptAccepted) { stateRequests++; setTimeout(() => { if (!agentStartNotified) { agentStartNotified = true; busy = true; process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n"); } respond(request, { data: { sessionId, busy: false, isStreaming: false, isCompacting: false, pendingMessageCount: 0, model: { provider: modelProvider, id: modelId }, thinkingLevel: thinking } }); }, Number(process.env.FAKE_PI_AGENT_START_DELAY || 10)); return; }',
    '  if (request.type === "get_state") { stateRequests++; if (process.env.FAKE_PI_MODE === "restart-fail-once" && startNumber === 2) return; if (process.env.FAKE_PI_MODE === "new-session-state-fails" && sessionId.startsWith("generated-")) return respond(request, { success: false, code: "state_failed", error: "state unavailable" }); if (Number(process.env.FAKE_PI_FAIL_STATE_AFTER || 0) > 0 && stateRequests > Number(process.env.FAKE_PI_FAIL_STATE_AFTER)) return respond(request, { success: false, code: "state_failed", error: "state unavailable" }); if (process.env.FAKE_PI_MODE === "never-starts") return respond(request, { data: { sessionId, busy: false, isStreaming: false, isCompacting: false, pendingMessageCount: 0, model: { provider: modelProvider, id: modelId }, thinkingLevel: thinking } }); if (process.env.FAKE_PI_MODE === "delayed-agent-start") { if (stateRequests > Number(process.env.FAKE_PI_STATE_DELAY || 3)) { if (!agentStartNotified) { agentStartNotified = true; process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n"); } return respond(request, { data: { sessionId, busy: true, isStreaming: true, isCompacting: false, pendingMessageCount: 0, model: { provider: modelProvider, id: modelId }, thinkingLevel: thinking } }); } return respond(request, { data: { sessionId, busy: false, isStreaming: false, isCompacting: false, pendingMessageCount: 0, model: { provider: modelProvider, id: modelId }, thinkingLevel: thinking } }); } const orbitBusyOnly = process.env.FAKE_PI_MODE === "orbit-busy-without-agent-start"; return respond(request, { data: { sessionId, busy, isStreaming: orbitBusyOnly ? false : busy, isCompacting: false, pendingMessageCount: 0, model: { provider: modelProvider, id: modelId }, thinkingLevel: thinking } }); }',
    '  if (request.type === "switch_session") { sessionId = JSON.parse(fs.readFileSync(request.sessionPath, "utf8").split("\\n")[0]).id; return respond(request); }',
    '  if (request.type === "new_session" || request.type === "clone" || request.type === "fork") { sessionId = `generated-${++counter}-${process.pid}`; return respond(request); }',
    '  if (request.type === "prompt") { if (process.env.FAKE_PI_MODE === "prompt-timeout") return; if (process.env.FAKE_PI_MODE === "runs-without-events") { busy = true; respond(request); setTimeout(() => { if (process.env.FAKE_PI_SESSION_FILE) { fs.appendFileSync(process.env.FAKE_PI_SESSION_FILE, JSON.stringify({ type: "message", id: `msg-rwe-${counter++}`, parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "recovered reply" }] } }) + "\\n"); } if (process.env.FAKE_PI_WRITE_FILE) { fs.mkdirSync(path.dirname(process.env.FAKE_PI_WRITE_FILE), { recursive: true }); fs.writeFileSync(process.env.FAKE_PI_WRITE_FILE, "recovered artifact\\n"); } busy = false; }, 50); return; } if (process.env.FAKE_PI_MODE === "idle-active-idle" || process.env.FAKE_PI_MODE === "late-agent-start") promptAccepted = true; busy = true; respond(request); if (process.env.FAKE_PI_MODE === "turn-artifacts") { process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n"); setTimeout(() => { if (process.env.FAKE_PI_WRITE_FILE) { fs.mkdirSync(path.dirname(process.env.FAKE_PI_WRITE_FILE), { recursive: true }); fs.writeFileSync(process.env.FAKE_PI_WRITE_FILE, "turn artifact data\\n"); } busy = false; process.stdout.write(JSON.stringify({ type: "agent_settled", messageId: "msg-turn-1" }) + "\\n"); }, Number(process.env.FAKE_PI_SETTLE_DELAY || 50)); return; } if (process.env.FAKE_PI_MODE === "turn-artifacts-partid") { process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n"); setTimeout(() => { if (process.env.FAKE_PI_WRITE_FILE) { fs.mkdirSync(path.dirname(process.env.FAKE_PI_WRITE_FILE), { recursive: true }); fs.writeFileSync(process.env.FAKE_PI_WRITE_FILE, "turn artifact data\\n"); } process.stdout.write(JSON.stringify({ type: "message_update", message: { id: "msg-early" }, assistantMessageEvent: { type: "text_delta", text: "hel", contentIndex: "0" } }) + "\\n"); process.stdout.write(JSON.stringify({ type: "message_update", message: { id: "part-turn-1" }, assistantMessageEvent: { type: "text_end", text: "hello", contentIndex: "0" } }) + "\\n"); busy = false; process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n"); }, 50); return; } if (process.env.FAKE_PI_MODE !== "orbit-busy-without-agent-start" && process.env.FAKE_PI_MODE !== "never-starts" && process.env.FAKE_PI_MODE !== "delayed-agent-start" && process.env.FAKE_PI_MODE !== "idle-active-idle" && process.env.FAKE_PI_MODE !== "late-agent-start") process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n"); return; }',
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
  // Leave enough headroom for spawning the fake Pi under CI load. Windows
  // process startup and pipe delivery are substantially slower even when the
  // server test files themselves are serialized.
  // Timeout-specific tests still complete quickly because the fake process is
  // already running before the intentionally unanswered RPC is sent.
  process.env.PI_SCIENCE_RPC_TIMEOUT_MS = process.platform === "win32" ? "1500" : "500";
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
  if (original.stateDelay === undefined) delete process.env.FAKE_PI_STATE_DELAY;
  else process.env.FAKE_PI_STATE_DELAY = original.stateDelay;
  if (original.activeProbe === undefined) delete process.env.FAKE_PI_ACTIVE_PROBE;
  else process.env.FAKE_PI_ACTIVE_PROBE = original.activeProbe;
  if (original.agentStartDelay === undefined) delete process.env.FAKE_PI_AGENT_START_DELAY;
  else process.env.FAKE_PI_AGENT_START_DELAY = original.agentStartDelay;
  if (original.sessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE;
  else process.env.FAKE_PI_SESSION_FILE = original.sessionFile;
  if (original.piMode === undefined) delete process.env.PI_SCIENCE_PI_MODE;
  else process.env.PI_SCIENCE_PI_MODE = original.piMode;
  if (original.watchdog === undefined) delete process.env.PI_SCIENCE_EVENT_WATCHDOG_MS;
  else process.env.PI_SCIENCE_EVENT_WATCHDOG_MS = original.watchdog;
  delete process.env.FAKE_PI_LOG;
  delete process.env.FAKE_PI_ARGS_LOG;
  delete process.env.FAKE_PI_STARTS;
  if (original.argsLog === undefined) delete process.env.FAKE_PI_ARGS_LOG;
  else process.env.FAKE_PI_ARGS_LOG = original.argsLog;
  delete process.env.FAKE_PI_FAIL_STATE_AFTER;
  delete process.env.FAKE_PI_FAIL_START_FILE;
  delete process.env.FAKE_PI_SETTLE_DELAY;
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

  it("preserves discovered defaults when create receives empty arrays and honors explicit config arrays", async () => {
    const cwd = await workspaceWithSessions();
    const defaultSkill = join(cwd, "default-skill");
    await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), JSON.stringify({ skill_paths: [defaultSkill] }), "utf8");
    const defaults = loadDefaultPiConfig();
    const argsLog = join(cwd, "launch-args.jsonl");
    process.env.FAKE_PI_ARGS_LOG = argsLog;
    const service = testService();

    await expect(service.create({ cwd, config: { skills: [], extensions: [] } })).resolves.toHaveProperty("id");
    const explicitSkill = join(cwd, "explicit-skill");
    const explicitExtension = join(cwd, "explicit-extension.ts");
    await expect(service.create({ cwd, config: { skills: [explicitSkill], extensions: [explicitExtension] } })).resolves.toHaveProperty("id");

    const launches = (await readFile(argsLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(launches).toHaveLength(2);
    const values = (args: string[], flag: string) => args.flatMap((arg, index) => arg === flag && args[index + 1] ? [args[index + 1]!] : []);
    const defaultSkills = values(launches[0]!, "--skill");
    const defaultExtensions = values(launches[0]!, "-e");
    expect(defaultSkills).toContain(defaultSkill);
    for (const extension of defaults.extensions) expect(defaultExtensions).toContain(extension);
    expect(values(launches[1]!, "--skill")).toContain(explicitSkill);
    expect(values(launches[1]!, "--skill")).not.toContain(defaultSkill);
    expect(values(launches[1]!, "-e")).toEqual([explicitExtension]);
    await service.shutdownAll();
  });

  it("keeps default extensions when create receives empty config arrays", async () => {
    const service = testService();
    const cwd = await workspaceWithSessions();
    const upstream = join(cwd, "node_modules", "@juicesharp", "rpiv-ask-user-question", "index.ts");
    await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), JSON.stringify({ extension_paths: [upstream] }), "utf8");

    try {
      await expect(service.create({ cwd, config: { skills: [], extensions: [] } })).resolves.toHaveProperty("id");

      const args = JSON.parse(await readFile(process.env.FAKE_PI_ARGS_LOG!, "utf8")) as string[];
      expect(args).toContain("-e");
      expect(args).toContain(join(import.meta.dirname, "../pi/extensions/pi-science-ask-user-question-web.ts"));
      expect(args).not.toContain(upstream);
    } finally {
      await service.shutdownAll();
    }
  });

  it("does not keep a resumed session busy after an acknowledged prompt and runtime restart", async () => {
    const service = testService();
    const cwd = await workspaceWithSessions("session-restart-resume");
    await service.resume("session-restart-resume", cwd);
    await expect(service.command("session-restart-resume", cwd, "prompt", { message: "acknowledged" })).resolves.toMatchObject({ success: true });
    await service.shutdownAll();

    const resumed = testService();
    await expect(resumed.resume("session-restart-resume", cwd)).resolves.toEqual({ success: true });
    await expect(resumed.state("session-restart-resume", cwd)).resolves.toMatchObject({
      id: "session-restart-resume",
      is_streaming: false,
      is_compacting: false,
      pending_message_count: 0,
    });
    // Let any reconciliation timer from the old runtime's acknowledged prompt
    // reach its callback; it must not resurrect a stale busy state in the new
    // runtime after resume.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(resumed.state("session-restart-resume", cwd)).resolves.toMatchObject({
      is_streaming: false,
      pending_message_count: 0,
    });
    await resumed.shutdownAll();
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

  it("waits while Pi Orbit resumes a session or warms a model after a prompt ack", async () => {
    process.env.FAKE_PI_MODE = "delayed-agent-start";
    process.env.FAKE_PI_STATE_DELAY = "3";
    const service = testService();
    const cwd = await workspaceWithSessions("session-slow-start");
    const publish = vi.spyOn(conversationEventHub, "publish");
    await service.resume("session-slow-start", cwd);

    await expect(service.command("session-slow-start", cwd, "prompt", { message: "test" })).resolves.toMatchObject({ success: true });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(publish).not.toHaveBeenCalledWith(cwd, "session-slow-start", expect.objectContaining({
      message: "The prompt was accepted but the Pi runtime did not start an agent turn.",
    }));
    await expect(service.state("session-slow-start", cwd)).resolves.toMatchObject({ id: "session-slow-start" });
    await service.command("session-slow-start", cwd, "abort");
    publish.mockRestore();
    await service.shutdownAll();
  });

  it("resets idle reconciliation attempts after an active probe", async () => {
    process.env.FAKE_PI_MODE = "idle-active-idle";
    const service = testService();
    const cwd = await workspaceWithSessions("session-idle-active-idle");
    const publish = vi.spyOn(conversationEventHub, "publish");
    await service.resume("session-idle-active-idle", cwd);

    await expect(service.command("session-idle-active-idle", cwd, "prompt", { message: "test" })).resolves.toMatchObject({ success: true });
    // The fake runtime suppresses agent_start so this path must be driven by
    // reconciliation. It returns four idle probes, an active probe, then four
    // more idle probes; the second idle run must start at attempt one.
    let probes: Array<{ phase: string; probe: number; active: boolean }> = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const log = await readFile(process.env.FAKE_PI_LOG!, "utf8");
      probes = log.split("\n")
        .filter((line) => line.includes('"type":"state_probe"'))
        .map((line) => JSON.parse(line) as { phase: string; probe: number; active: boolean })
        .filter((probe) => probe.phase === "reconciliation");
      const activeIndex = probes.findIndex((probe) => probe.active);
      if (activeIndex >= 0 && probes.length >= activeIndex + 5) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const activeIndex = probes.findIndex((probe) => probe.active);
    expect(activeIndex).toBeGreaterThanOrEqual(0);
    expect(probes.slice(activeIndex + 1, activeIndex + 5).every((probe) => !probe.active)).toBe(true);
    expect(publish).not.toHaveBeenCalledWith(cwd, "session-idle-active-idle", expect.objectContaining({
      message: "The prompt was accepted but the Pi runtime did not start an agent turn.",
    }));
    publish.mockRestore();
    await service.shutdownAll();
  });

  it("waits through the Pi Orbit startup reconciliation deadline before reporting did-not-start", async () => {
    process.env.FAKE_PI_MODE = "never-starts";
    process.env.PI_SCIENCE_RECONCILE_DELAY_MS = "20";
    process.env.PI_SCIENCE_RECONCILE_DEADLINE_MS = "260";
    const service = testService();
    const cwd = await workspaceWithSessions("session-never-starts");
    const publish = vi.spyOn(conversationEventHub, "publish");
    await service.resume("session-never-starts", cwd);

    await expect(service.command("session-never-starts", cwd, "prompt", { message: "test" })).resolves.toMatchObject({ success: true });
    const acceptedAt = Date.now();
    await waitFor(() => publish.mock.calls.some((call) => (call[2] as { message?: string } | undefined)?.message === "The prompt was accepted but the Pi runtime did not start an agent turn."));
    // The error publication is recorded by the spy before the durable/live
    // publish promise yields to the matching terminal idle publication. Wait
    // for both records so parallel CI load cannot observe that intentional
    // append window between the two calls.
    await waitFor(() => publish.mock.calls.some((call) => (call[2] as { type?: string } | undefined)?.type === "session.idle"));
    expect(Date.now() - acceptedAt).toBeGreaterThanOrEqual(200);
    const syntheticIdle = publish.mock.calls.filter((call) => (call[2] as { type?: string } | undefined)?.type === "session.idle");
    expect(syntheticIdle).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const didNotStartAfter = publish.mock.calls.filter((call) => (call[2] as { message?: string } | undefined)?.message === "The prompt was accepted but the Pi runtime did not start an agent turn.");
    expect(didNotStartAfter).toHaveLength(1);

    // The startup reconciliation deadline, not a fixed attempt count, bounds
    // accepted-idle probes; it does not bound the full agent response.
    const log = await readFile(process.env.FAKE_PI_LOG!, "utf8");
    const promptLine = log.split("\n").findIndex((line) => line.includes('"type":"prompt"'));
    const idleProbes = log.split("\n").slice(promptLine + 1).filter((line) => line.includes('"type":"get_state"')).length;
    expect(idleProbes).toBeGreaterThanOrEqual(5);
    publish.mockRestore();
    await service.shutdownAll();
  });

  it("uses a 120-second default for Pi Orbit startup reconciliation", async () => {
    delete process.env.PI_SCIENCE_RECONCILE_DEADLINE_MS;
    process.env.FAKE_PI_MODE = "never-starts";
    const service = testService();
    const cwd = await workspaceWithSessions("session-default-reconcile-deadline");
    await service.resume("session-default-reconcile-deadline", cwd);

    const acceptedAt = Date.now();
    await expect(service.command("session-default-reconcile-deadline", cwd, "prompt", { message: "test" })).resolves.toMatchObject({ success: true });
    const runtime = (service as unknown as { runtimes: Map<string, { operationDeadline?: number }> }).runtimes.get(`${resolve(cwd)}\0session-default-reconcile-deadline`);
    expect(runtime?.operationDeadline).toBeGreaterThanOrEqual(acceptedAt + 120_000);
    await service.shutdownAll();
  });

  it("does not report did-not-start after five idle probes when the runtime then becomes active", async () => {
    process.env.FAKE_PI_MODE = "idle-active-idle";
    process.env.FAKE_PI_ACTIVE_PROBE = "5";
    const service = testService();
    const cwd = await workspaceWithSessions("session-idle-five-before-active");
    const publish = vi.spyOn(conversationEventHub, "publish");
    await service.resume("session-idle-five-before-active", cwd);

    await expect(service.command("session-idle-five-before-active", cwd, "prompt", { message: "test" })).resolves.toMatchObject({ success: true });
    await waitFor(async () => (await readFile(process.env.FAKE_PI_LOG!, "utf8")).split("\n").some((line) => line.includes('"type":"state_probe"') && line.includes('"active":true')));
    const probes = (await readFile(process.env.FAKE_PI_LOG!, "utf8")).split("\n")
      .filter((line) => line.includes('"type":"state_probe"'))
      .map((line) => JSON.parse(line) as { phase: string; probe: number; active: boolean })
      .filter((probe) => probe.phase === "reconciliation");
    expect(probes.findIndex((probe) => probe.active)).toBeGreaterThanOrEqual(5);
    expect(publish).not.toHaveBeenCalledWith(cwd, "session-idle-five-before-active", expect.objectContaining({
      message: "The prompt was accepted but the Pi runtime did not start an agent turn.",
    }));
    publish.mockRestore();
    await service.command("session-idle-five-before-active", cwd, "abort");
    await service.shutdownAll();
  });

  it("does not issue a reconciliation probe after the deadline has elapsed", async () => {
    process.env.FAKE_PI_MODE = "never-starts";
    process.env.PI_SCIENCE_RECONCILE_DELAY_MS = "100";
    process.env.PI_SCIENCE_RECONCILE_DEADLINE_MS = "50";
    const service = testService();
    const cwd = await workspaceWithSessions("session-deadline-no-probe");
    const publish = vi.spyOn(conversationEventHub, "publish");
    await service.resume("session-deadline-no-probe", cwd);

    await expect(service.command("session-deadline-no-probe", cwd, "prompt", { message: "test" })).resolves.toMatchObject({ success: true });
    await waitFor(() => publish.mock.calls.some((call) => (call[2] as { message?: string } | undefined)?.message === "The prompt was accepted but the Pi runtime did not start an agent turn."));
    // The spy records the terminal idle call before its asynchronous publish
    // resolves. Wait for the reconciliation cleanup itself so slower Windows
    // scheduling cannot observe the operation between publish and cleanup.
    const runtime = (service as unknown as { runtimes: Map<string, { operationToken?: string; operationPending?: string }> }).runtimes.get(`${resolve(cwd)}\0session-deadline-no-probe`);
    await waitFor(() => publish.mock.calls.some((call) => (call[2] as { type?: string } | undefined)?.type === "session.idle")
      && runtime?.operationToken === undefined
      && runtime?.operationPending === undefined);

    const log = await readFile(process.env.FAKE_PI_LOG!, "utf8");
    const lines = log.split("\n");
    const promptLine = lines.findIndex((line) => line.includes('"type":"prompt"'));
    const probesAfterPrompt = lines.slice(promptLine + 1).filter((line) => line.includes('"type":"get_state"'));
    expect(probesAfterPrompt).toHaveLength(0);
    expect(publish.mock.calls.filter((call) => (call[2] as { type?: string } | undefined)?.type === "session.idle")).toHaveLength(1);
    expect(runtime?.operationToken).toBeUndefined();
    expect(runtime?.operationPending).toBeUndefined();
    publish.mockRestore();
    await service.shutdownAll();
  });

  it("cancels a synthetic terminal when agent_start invalidates its append window", async () => {
    process.env.FAKE_PI_MODE = "never-starts";
    process.env.PI_SCIENCE_RECONCILE_DELAY_MS = "100";
    process.env.PI_SCIENCE_RECONCILE_DEADLINE_MS = "1";
    const persisted: SseEventRecord[] = [];
    let releaseAppend!: () => void;
    let appendStarted!: () => void;
    const appendReady = new Promise<void>((resolve) => { appendStarted = resolve; });
    const appendRelease = new Promise<void>((resolve) => { releaseAppend = resolve; });
    const store = {
      append: async (_cwd: string, _sessionId: string, record: SseEventRecord) => { persisted.push(record); },
      appendConditional: async (_cwd: string, _sessionId: string, record: SseEventRecord, guard: () => boolean) => {
        appendStarted();
        await appendRelease;
        if (!guard()) return false;
        persisted.push(record);
        return true;
      },
      readAfter: async () => persisted.map((record) => ({ ...record })),
    };
    const eventHub = new ConversationEventHub(store);
    const received: SseEventRecord[] = [];
    const service = new NodeSessionService(eventHub, undefined, undefined, passthroughEnvironments);
    const cwd = await workspaceWithSessions("session-conditional-terminal");
    await service.resume("session-conditional-terminal", cwd);
    await eventHub.subscribe(cwd, "session-conditional-terminal", undefined, (record) => received.push(record), false);

    await expect(service.command("session-conditional-terminal", cwd, "prompt", { message: "test" })).resolves.toMatchObject({ success: true });
    await appendReady;
    const runtime = [...(service as unknown as { runtimes: Map<string, { process: { emit: (event: string, payload: unknown) => boolean } }> }).runtimes.values()][0]!;
    runtime.process.emit("event", { type: "agent_start" });
    releaseAppend();
    await eventHub.flush();

    const synthetic = (record: SseEventRecord) => {
      const payload = JSON.parse(record.data) as { message?: string; type?: string };
      return payload.message === "The prompt was accepted but the Pi runtime did not start an agent turn." || payload.type === "session.idle";
    };
    expect(persisted.filter(synthetic)).toEqual([]);
    expect(received.filter(synthetic)).toEqual([]);
    expect(received.map((record) => JSON.parse(record.data).type)).toContain("agent_start");
    await service.shutdownAll();
  });

  it("ignores a late agent_start while a reconciliation state request is in flight", async () => {
    process.env.FAKE_PI_MODE = "late-agent-start";
    process.env.FAKE_PI_AGENT_START_DELAY = "10";
    const service = testService();
    const cwd = await workspaceWithSessions("session-late-agent-start");
    const publish = vi.spyOn(conversationEventHub, "publish");
    await service.resume("session-late-agent-start", cwd);

    await expect(service.command("session-late-agent-start", cwd, "prompt", { message: "test" })).resolves.toMatchObject({ success: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(publish).not.toHaveBeenCalledWith(cwd, "session-late-agent-start", expect.objectContaining({
      message: "The prompt was accepted but the Pi runtime did not start an agent turn.",
    }));
    expect(publish).not.toHaveBeenCalledWith(cwd, "session-late-agent-start", expect.objectContaining({ type: "session.idle" }));
    publish.mockRestore();
    await service.command("session-late-agent-start", cwd, "abort");
    await service.shutdownAll();
  });

  it("fails fast on the first idle probe after a transport timeout instead of retrying", async () => {
    process.env.FAKE_PI_MODE = "prompt-timeout";
    const service = testService();
    const cwd = await workspaceWithSessions("session-timeout-failfast");
    const publish = vi.spyOn(conversationEventHub, "publish");
    await service.resume("session-timeout-failfast", cwd);
    const before = await readFile(process.env.FAKE_PI_LOG!, "utf8");

    await expect(service.command("session-timeout-failfast", cwd, "prompt", { message: "test" })).resolves.toMatchObject({ code: "timeout" });
    await waitFor(() => publish.mock.calls.some((call) => (call[2] as { type?: string } | undefined)?.type === "session.idle"));

    const after = await readFile(process.env.FAKE_PI_LOG!, "utf8");
    const count = (text: string) => text.split("\n").filter((line) => line.includes('"type":"get_state"')).length;
    // A fresh state cached by resume can skip the optional preflight refresh;
    // either way there is exactly one immediate fail-fast probe and no retry
    // rounds after it.
    const probes = count(after) - count(before);
    expect(probes).toBeGreaterThanOrEqual(1);
    expect(probes).toBeLessThanOrEqual(2);
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

  it("publishes turn.artifacts with files created during the turn", async () => {
    process.env.FAKE_PI_MODE = "turn-artifacts";
    const service = testService();
    const cwd = await workspaceWithSessions("session-turn-artifacts");
    const writePath = join(cwd, "work", "plot.png");
    process.env.FAKE_PI_WRITE_FILE = writePath;
    await service.resume("session-turn-artifacts", cwd);
    const publish = vi.spyOn(conversationEventHub, "publish");
    await expect(service.command("session-turn-artifacts", cwd, "prompt", { message: "go" })).resolves.toMatchObject({ success: true });
    await waitFor(() => {
      return publish.mock.calls.some(([, , payload]) => (payload as { type?: string }).type === "turn.artifacts");
    });
    const turnEvent = publish.mock.calls.find(([, , payload]) => (payload as { type?: string }).type === "turn.artifacts")?.[2] as Record<string, unknown>;
    expect(turnEvent).toMatchObject({ type: "turn.artifacts", assistantMessageId: "msg-turn-1", turnOrdinal: 1 });
    expect(turnEvent.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "work/plot.png", kind: "image" }),
    ]));
    await service.shutdownAll();
  });

  it("recovers the artifact summary from message-side evidence when the event stream is dead", async () => {
    process.env.FAKE_PI_MODE = "runs-without-events";
    const service = testService();
    const cwd = await workspaceWithSessions("session-rwe");
    process.env.FAKE_PI_SESSION_FILE = join(cwd, ".pi-science", "sessions", "session-rwe.jsonl");
    process.env.FAKE_PI_WRITE_FILE = join(cwd, "work", "recovered.txt");
    await service.resume("session-rwe", cwd);
    const publish = vi.spyOn(conversationEventHub, "publish");
    publish.mockClear();
    await expect(service.command("session-rwe", cwd, "prompt", { message: "go" })).resolves.toMatchObject({ success: true });
    // The turn completes on the Pi side (assistant message appended to the
    // session JSONL) with zero events emitted; reconciliation must end the
    // operation normally instead of reporting did-not-start.
    await waitFor(() => publish.mock.calls.some(([, , payload]) => (payload as { type?: string }).type === "session.idle"));
    expect(publish.mock.calls.some(([, , payload]) => String((payload as { message?: unknown }).message ?? "").includes("did not start"))).toBe(false);
    // Recovered artifact summary: persisted record + turn.artifacts event.
    const turnEvent = publish.mock.calls.find(([, , payload]) => (payload as { type?: string }).type === "turn.artifacts")?.[2] as Record<string, unknown> | undefined;
    expect(turnEvent).toBeDefined();
    expect(turnEvent!.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "work/recovered.txt" }),
    ]));
    const turnId = turnEvent!.turnId as string;
    const records = await readJsonLines<{ turn_id?: string; artifacts?: Array<{ path?: string }> }>(join(cwd, ".pi-science", "turn-artifacts.jsonl"));
    expect(records.some((r) => r.turn_id === turnId && r.artifacts?.some((a) => a.path === "work/recovered.txt"))).toBe(true);
    await service.shutdownAll();
    publish.mockRestore();
  });

  it("invalidates a cached busy state when the agent settles", async () => {
    process.env.FAKE_PI_MODE = "turn-artifacts";
    process.env.FAKE_PI_SETTLE_DELAY = "200";
    const service = testService();
    const cwd = await workspaceWithSessions("session-state-cache");
    await service.resume("session-state-cache", cwd);
    const publish = vi.spyOn(conversationEventHub, "publish");
    publish.mockClear();

    await expect(service.command("session-state-cache", cwd, "prompt", { message: "go" })).resolves.toMatchObject({ success: true });
    // Seed the short-lived get_state cache while the fake agent is running.
    await expect(service.state("session-state-cache", cwd)).resolves.toMatchObject({ is_streaming: true });
    await waitFor(() => publish.mock.calls.some(([, , payload]) => (payload as { type?: string }).type === "session.idle"));

    // agent_settled is authoritative and must invalidate that cached busy
    // snapshot immediately; otherwise a page refresh can resurrect Working.
    await expect(service.state("session-state-cache", cwd)).resolves.toMatchObject({ is_streaming: false });
    publish.mockRestore();
    await service.shutdownAll();
  });

  it("anchors turn.artifacts to the last assistant message id from raw message_update events", async () => {
    process.env.FAKE_PI_MODE = "turn-artifacts-partid";
    const service = testService();
    const cwd = await workspaceWithSessions("session-turn-artifacts-partid");
    process.env.FAKE_PI_WRITE_FILE = join(cwd, "work", "plot.png");
    await service.resume("session-turn-artifacts-partid", cwd);
    const publish = vi.spyOn(conversationEventHub, "publish");
    // spyOn reuses a live mock when an earlier test left one behind; clear so
    // this test only sees its own publishes.
    publish.mockClear();
    await expect(service.command("session-turn-artifacts-partid", cwd, "prompt", { message: "go" })).resolves.toMatchObject({ success: true });
    await waitFor(() => {
      return publish.mock.calls.some(([, , payload]) => (payload as { type?: string }).type === "turn.artifacts");
    });
    const turnEvent = publish.mock.calls.find(([, , payload]) => (payload as { type?: string }).type === "turn.artifacts")?.[2] as Record<string, unknown>;
    expect(turnEvent).toMatchObject({ type: "turn.artifacts", assistantMessageId: "part-turn-1", turnOrdinal: 1 });
    expect(turnEvent.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "work/plot.png", kind: "image" }),
    ]));
    await service.shutdownAll();
  });

  it("continues turn ordinals across runtime rebuilds from persisted records", async () => {
    process.env.FAKE_PI_MODE = "turn-artifacts-partid";
    const cwd = await workspaceWithSessions("session-turn-ordinal-rebuild");
    process.env.FAKE_PI_WRITE_FILE = join(cwd, "work", "plot.png");

    // First runtime handles the first turn, then the whole service (and its
    // runtime) is torn down — the second runtime is a fresh process.
    const first = testService();
    await first.resume("session-turn-ordinal-rebuild", cwd);
    const firstPublish = vi.spyOn(conversationEventHub, "publish");
    // Clear the spy before prompting: earlier tests may have left calls behind,
    // which would let waitFor succeed on stale events and tear down the runtime
    // before this turn actually completes.
    firstPublish.mockClear();
    await expect(first.command("session-turn-ordinal-rebuild", cwd, "prompt", { message: "go" })).resolves.toMatchObject({ success: true });
    await waitFor(() => {
      return firstPublish.mock.calls.some(([, , payload]) => (payload as { type?: string }).type === "turn.artifacts");
    });
    const firstEvent = firstPublish.mock.calls.find(([, , payload]) => (payload as { type?: string }).type === "turn.artifacts")?.[2] as Record<string, unknown>;
    expect(firstEvent).toMatchObject({ type: "turn.artifacts", turnOrdinal: 1 });
    await first.shutdownAll();

    const second = testService();
    await second.resume("session-turn-ordinal-rebuild", cwd);
    const secondPublish = vi.spyOn(conversationEventHub, "publish");
    secondPublish.mockClear();
    await expect(second.command("session-turn-ordinal-rebuild", cwd, "prompt", { message: "go" })).resolves.toMatchObject({ success: true });
    await waitFor(() => {
      return secondPublish.mock.calls.some(([, , payload]) => (payload as { type?: string }).type === "turn.artifacts");
    });
    const secondEvent = secondPublish.mock.calls.find(([, , payload]) => (payload as { type?: string }).type === "turn.artifacts")?.[2] as Record<string, unknown>;
    expect(secondEvent).toMatchObject({ type: "turn.artifacts", turnOrdinal: 2 });
    await second.shutdownAll();
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

  it("deletes a session whose JSONL appears only after runtime cleanup", async () => {
    const service = testService();
    const cwd = await workspaceWithSessions();
    const sessionId = "flush-late";
    const file = join(cwd, ".pi-science", "sessions", `${sessionId}.jsonl`);
    // An active runtime whose JSONL is written only when it is torn down —
    // the flush the delete path must wait for before it re-reads the disk.
    (service as unknown as { runtimes: Map<string, unknown> }).runtimes.set(
      `${resolve(cwd)}\0${sessionId}`,
      { activeSessionId: sessionId, busy: false, closing: false } as never,
    );
    vi.spyOn(service as unknown as { cleanupRuntime: () => Promise<void> }, "cleanupRuntime").mockImplementation(async () => {
      await writeFile(file, `${JSON.stringify({ type: "session", id: sessionId, cwd, timestamp: new Date().toISOString() })}\n`, "utf8");
    });
    await expect(service.delete(sessionId, cwd)).resolves.toEqual({ success: true });
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    // cleanupRuntime is mocked here, so the entry stays in the map — drop it
    // before shutdownAll so the teardown does not touch a fake runtime.
    (service as unknown as { runtimes: Map<string, unknown> }).runtimes.delete(`${resolve(cwd)}\0${sessionId}`);
    await service.shutdownAll();
  });

  it("treats a ghost session (no file, no runtime) as successfully deleted", async () => {
    const service = testService();
    const cwd = await workspaceWithSessions();
    await expect(service.delete("ghost-session", cwd)).resolves.toEqual({ success: true });
    await service.shutdownAll();
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

describe("Event-stream watchdog", () => {
  function fakeHostProcess(overrides: Partial<{ lastEventAt: number; eventStreamAlive: boolean; sendCommandResult: Record<string, unknown>; sendCommandImpl: (type: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>> }>) {
    const reconnectEventStream = vi.fn(async () => {});
    const sendCommand = vi.fn(async (type: string, params?: Record<string, unknown>) => {
      if (overrides.sendCommandImpl) return overrides.sendCommandImpl(type, params);
      return overrides.sendCommandResult ?? { success: true };
    });
    const piProcess = {
      attachedToHost: true,
      lastEventAt: overrides.lastEventAt ?? 0,
      eventStreamAlive: overrides.eventStreamAlive ?? true,
      reconnectEventStream,
      sendCommand,
    } as unknown as import("../pi/pi-process.js").PiProcess;
    return { process: piProcess, reconnectEventStream, sendCommand };
  }

  function injectRuntime(service: NodeSessionService, process: ReturnType<typeof fakeHostProcess>["process"], cwd: string, sessionId: string) {
    const runtime = {
      cwd: resolve(cwd),
      managerKey: "test-key",
      process,
      activeSessionId: sessionId,
      config: { model: null, provider: null, api_key: null, thinking: null, compaction_enabled: true, compaction_threshold_percent: 87, model_context_window: null, skills: [], extensions: [] },
      busy: false,
      restartPending: false,
      closing: false,
    };
    (service as unknown as { runtimes: Map<string, unknown> }).runtimes.set(`${resolve(cwd)}\0${sessionId}`, runtime);
    return runtime;
  }

  it("reconnects the silent event stream while busy, then restarts only after get_state fails", async () => {
    process.env.PI_SCIENCE_EVENT_WATCHDOG_MS = "40";
    const service = testService();
    const cwd = resolve(join(tmpdir(), `watchdog-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`));
    await mkdir(cwd, { recursive: true });
    const { process: piProcess, reconnectEventStream, sendCommand } = fakeHostProcess({ sendCommandResult: { success: false, code: "timeout", error: "unresponsive" } });
    injectRuntime(service, piProcess, cwd, "s1");
    const restart = vi.fn(async () => ({ error: "boom", code: "spawn_failed" }));
    (service as unknown as { restartRuntimeUnlocked: unknown }).restartRuntimeUnlocked = restart;
    (service as unknown as { beginPendingOperation: (runtime: unknown, op: string) => void }).beginPendingOperation(
      (service as unknown as { runtimes: Map<string, unknown> }).runtimes.get(`${resolve(cwd)}\0s1`)!,
      "prompt",
    );
    await waitFor(() => reconnectEventStream.mock.calls.length >= 2);
    await waitFor(() => sendCommand.mock.calls.length >= 1);
    await waitFor(() => restart.mock.calls.length === 1);
    expect(restart).toHaveBeenCalledTimes(1);
    await service.shutdownAll();
  });

  it("does not fire while the runtime is idle or the stream is fresh", async () => {
    process.env.PI_SCIENCE_EVENT_WATCHDOG_MS = "40";
    const service = testService();
    const cwd = resolve(join(tmpdir(), `watchdog-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`));
    await mkdir(cwd, { recursive: true });
    const { process: piProcess, reconnectEventStream } = fakeHostProcess({ lastEventAt: Date.now() });
    const runtime = injectRuntime(service, piProcess, cwd, "s1");
    // Idle (no pending operation, not busy): arming the watchdog must not
    // schedule anything.
    (service as unknown as { scheduleEventWatchdog: (runtime: unknown) => void }).scheduleEventWatchdog(runtime);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(reconnectEventStream).not.toHaveBeenCalled();
    // Fresh stream while busy: watchdog re-arms instead of reconnecting.
    (service as unknown as { beginPendingOperation: (runtime: unknown, op: string) => void }).beginPendingOperation(runtime, "prompt");
    const keepFresh = setInterval(() => { piProcess.lastEventAt = Date.now(); }, 10);
    await new Promise((resolve) => setTimeout(resolve, 150));
    clearInterval(keepFresh);
    expect(reconnectEventStream).not.toHaveBeenCalled();
    await service.shutdownAll();
  });

  it("revives a known-dead event stream before a prompt mutation (item 5)", async () => {
    const service = testService();
    const cwd = await workspaceWithSessions("s1");
    const stateData = { sessionId: "s1", busy: false, isStreaming: false, isCompacting: false, pendingMessageCount: 0, model: { provider: "openrouter", id: "openai/gpt-5.1" }, thinkingLevel: "high" };
    const { process: piProcess, reconnectEventStream, sendCommand } = fakeHostProcess({
      lastEventAt: Date.now() - 60_000,
      eventStreamAlive: false,
      sendCommandImpl: async (type) => type === "get_state" ? { success: true, data: stateData } : { success: true },
    });
    injectRuntime(service, piProcess, cwd, "s1");
    const result = await service.command("s1", cwd, "prompt", { message: "hi" });
    expect(result.success).toBe(true);
    expect(reconnectEventStream).toHaveBeenCalledTimes(1);
    // The prompt itself was still delivered after the revive.
    expect(sendCommand.mock.calls.some((call) => call[0] === "prompt")).toBe(true);
    await service.shutdownAll();
  });

  it("restarts the runtime when a dead stream cannot be revived and get_state fails (item 5)", async () => {
    const service = testService();
    const cwd = await workspaceWithSessions("s1");
    const { process: piProcess, reconnectEventStream, sendCommand } = fakeHostProcess({
      lastEventAt: Date.now() - 60_000,
      eventStreamAlive: false,
      sendCommandImpl: async () => ({ success: false, code: "timeout", error: "unresponsive" }),
    });
    injectRuntime(service, piProcess, cwd, "s1");
    const restart = vi.fn(async () => ({ error: "boom", code: "spawn_failed" }));
    (service as unknown as { restartRuntimeUnlocked: unknown }).restartRuntimeUnlocked = restart;
    const result = await service.command("s1", cwd, "prompt", { message: "hi" });
    expect(reconnectEventStream).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.code).toBe("runtime_restart_failed");
    await service.shutdownAll();
  });

  it("leaves alive or still-connecting streams alone before mutations (item 5)", async () => {
    const service = testService();
    const cwd = await workspaceWithSessions("s1", "s2");
    const stateData = { sessionId: "s1", busy: false, isStreaming: false, isCompacting: false, pendingMessageCount: 0, model: { provider: "openrouter", id: "openai/gpt-5.1" }, thinkingLevel: "high" };
    // Alive stream: no reconnect.
    const alive = fakeHostProcess({
      lastEventAt: Date.now() - 1_000,
      eventStreamAlive: true,
      sendCommandImpl: async (type) => type === "get_state" ? { success: true, data: stateData } : { success: true },
    });
    injectRuntime(service, alive.process, cwd, "s1");
    await service.command("s1", cwd, "prompt", { message: "hi" });
    expect(alive.reconnectEventStream).not.toHaveBeenCalled();
    // Still connecting (never connected): no reconnect either.
    const connecting = fakeHostProcess({
      lastEventAt: 0,
      eventStreamAlive: false,
      sendCommandImpl: async (type) => type === "get_state" ? { success: true, data: stateData } : { success: true },
    });
    injectRuntime(service, connecting.process, cwd, "s2");
    await service.command("s2", cwd, "prompt", { message: "hi" });
    expect(connecting.reconnectEventStream).not.toHaveBeenCalled();
    await service.shutdownAll();
  });
});
