import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationEventHub } from "./conversation-event-hub.js";
import { NodeSessionService } from "./node-session-service.js";

const cleanup: string[] = [];
const original = { home: process.env.PI_SCIENCE_HOME, cli: process.env.PI_CLI_PATH, node: process.env.PI_NODE_PATH, timeout: process.env.PI_SCIENCE_RPC_TIMEOUT_MS, delay: process.env.PI_SCIENCE_RECONCILE_DELAY_MS, deadline: process.env.PI_SCIENCE_RECONCILE_DEADLINE_MS, mode: process.env.FAKE_PI_MODE };

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
    '  if (request.type === "get_state") { stateRequests++; if (process.env.FAKE_PI_MODE === "restart-fail-once" && startNumber === 2) return; if (Number(process.env.FAKE_PI_FAIL_STATE_AFTER || 0) > 0 && stateRequests > Number(process.env.FAKE_PI_FAIL_STATE_AFTER)) return respond(request, { success: false, code: "state_failed", error: "state unavailable" }); return respond(request, { data: { sessionId, isStreaming: busy, isCompacting: false, pendingMessageCount: 0, model: { provider: modelProvider, id: modelId }, thinkingLevel: thinking } }); }',
    '  if (request.type === "switch_session") { sessionId = JSON.parse(fs.readFileSync(request.sessionPath, "utf8").split("\\n")[0]).id; return respond(request); }',
    '  if (request.type === "new_session" || request.type === "clone" || request.type === "fork") { sessionId = `generated-${++counter}-${process.pid}`; return respond(request); }',
    '  if (request.type === "prompt") { if (process.env.FAKE_PI_MODE === "prompt-timeout") return; busy = true; respond(request); process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n"); return; }',
    '  if (request.type === "compact") { if (process.env.FAKE_PI_MODE === "compact-timeout") return; return respond(request); }',
    '  if (request.type === "abort") { busy = false; respond(request); process.stdout.write(JSON.stringify({ type: "agent_settled", handledWithoutTurn: true }) + "\\n"); return; }',
    '  if (request.type === "get_commands") return process.env.FAKE_PI_MODE === "cancel-commands" ? respond(request, { data: { cancelled: true } }) : respond(request, { data: { commands: [{ name: "review", source: "skill" }] } });',
    '  if (request.type === "get_available_models") return respond(request, { data: { models: [{ provider: "openrouter", id: "openai/gpt-5.1", name: "GPT-5.1", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: null } }] } });',
    '  if (request.type === "set_model") { modelProvider = request.provider; modelId = request.modelId; return respond(request); }',
    '  if (request.type === "set_thinking_level") { if (request.level === "ultra") return process.stdout.write(JSON.stringify({ id: request.id, success: false, code: "invalid_thinking", error: "unsupported thinking" }) + "\\n"); thinking = request.level; return respond(request); }',
    '  respond(request);',
    '});',
  ].join("\n"), "utf8");
  process.env.PI_SCIENCE_HOME = join(root, "data");
  process.env.PI_CLI_PATH = script;
  process.env.PI_NODE_PATH = process.execPath;
  process.env.FAKE_PI_LOG = join(root, "rpc.jsonl");
  process.env.FAKE_PI_STARTS = join(root, "starts.txt");
  // Leave enough headroom for spawning the fake Pi under parallel CI load.
  // Timeout-specific tests still complete quickly because the fake process is
  // already running before the intentionally unanswered RPC is sent.
  process.env.PI_SCIENCE_RPC_TIMEOUT_MS = "500";
  process.env.PI_SCIENCE_RECONCILE_DELAY_MS = "20";
  process.env.PI_SCIENCE_RECONCILE_DEADLINE_MS = "700";
  process.env.FAKE_PI_FAIL_START_FILE = join(root, "fail-start");
});

afterEach(async () => {
  process.env.PI_SCIENCE_HOME = original.home;
  process.env.PI_CLI_PATH = original.cli;
  process.env.PI_NODE_PATH = original.node;
  process.env.PI_SCIENCE_RPC_TIMEOUT_MS = original.timeout;
  process.env.PI_SCIENCE_RECONCILE_DELAY_MS = original.delay;
  process.env.PI_SCIENCE_RECONCILE_DEADLINE_MS = original.deadline;
  process.env.FAKE_PI_MODE = original.mode;
  delete process.env.FAKE_PI_LOG;
  delete process.env.FAKE_PI_STARTS;
  delete process.env.FAKE_PI_FAIL_STATE_AFTER;
  delete process.env.FAKE_PI_FAIL_START_FILE;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspaceWithSessions(...ids: string[]): Promise<string> {
  const cwd = join(tmpdir(), `pi-science-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(cwd);
  const directory = join(cwd, ".pi-science", "sessions");
  await mkdir(directory, { recursive: true });
  for (const id of ids) await writeFile(join(directory, `${id}.jsonl`), `${JSON.stringify({ type: "session", id, cwd, timestamp: new Date().toISOString() })}\n`, "utf8");
  return realpath(cwd);
}

describe("Node session lifecycle", () => {
  it("switches atomically between persisted sessions", async () => {
    const service = new NodeSessionService();
    const cwd = await workspaceWithSessions("session-a", "session-b");
    await expect(service.state("session-a", cwd)).resolves.toMatchObject({ id: "session-a" });
    await expect(service.state("session-b", cwd)).resolves.toMatchObject({ id: "session-b" });
    await expect(service.state("session-a", cwd)).resolves.toMatchObject({ id: "session-a" });
    await service.shutdownAll();
  });

  it("creates consecutive blank sessions when no provider or model is configured", async () => {
    await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), JSON.stringify({ model: "", thinking: "off" }), "utf8");
    const service = new NodeSessionService();
    const cwd = await workspaceWithSessions();
    const first = await service.create({ cwd, config: { skills: [], extensions: [] } });
    const second = await service.create({ cwd, config: { skills: [], extensions: [] } });
    expect(first).toHaveProperty("id");
    expect(second).toHaveProperty("id");
    expect("id" in first && "id" in second ? second.id : "").not.toBe("id" in first ? first.id : "");
    await service.shutdownAll();
  });

  it("rejects disruptive operations while a turn is active and deletes exactly one session", async () => {
    const service = new NodeSessionService();
    const cwd = await workspaceWithSessions("session-a", "session-b");
    await service.resume("session-a", cwd);
    await expect(service.command("session-a", cwd, "prompt", { message: "hold" })).resolves.toMatchObject({ success: true });
    await expect(service.create({ cwd, config: { skills: [], extensions: [] } })).resolves.toMatchObject({ code: "busy" });
    await expect(service.command("session-a", cwd, "prompt", { message: "second" })).resolves.toMatchObject({ code: "busy" });
    await expect(service.delete("session-a", cwd)).resolves.toMatchObject({ code: "busy" });
    await service.command("session-a", cwd, "abort");
    await expect(service.delete("session-b", cwd)).resolves.toEqual({ success: true });
    await expect(service.state("session-a", cwd)).resolves.toMatchObject({ id: "session-a" });
    await service.shutdownAll();
  });

  it("preserves nested model IDs and supports commands, fork, and interaction notifications", async () => {
    const service = new NodeSessionService();
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

  it("reports configuration reload failures instead of silently succeeding", async () => {
    const service = new NodeSessionService();
    const cwd = await workspaceWithSessions("session-a");
    await expect(service.resume("session-a", cwd)).resolves.toEqual({ success: true });
    await writeFile(process.env.FAKE_PI_FAIL_START_FILE!, "fail", "utf8");
    await expect(service.reloadConfiguration()).rejects.toThrow(/process_exit|forced startup failure|pi process exited/i);
    await service.shutdownAll();
  });

  it("reconciles timed-out prompt and compact operations without leaving the workspace permanently busy", async () => {
    for (const mode of ["prompt-timeout", "compact-timeout"]) {
      process.env.FAKE_PI_MODE = mode;
      const service = new NodeSessionService();
      const cwd = await workspaceWithSessions(`session-${mode}`);
      await service.resume(`session-${mode}`, cwd);
      await expect(service.command(`session-${mode}`, cwd, mode.startsWith("prompt") ? "prompt" : "compact", { message: "test" })).resolves.toMatchObject({ code: "timeout" });
      await new Promise((resolve) => setTimeout(resolve, 130));
      await expect(service.create({ cwd, config: { skills: [], extensions: [] } })).resolves.toHaveProperty("id");
      await service.shutdownAll();
    }
  });

  it("rolls back a new session when configuration fails", async () => {
    const service = new NodeSessionService();
    const cwd = await workspaceWithSessions("session-a");
    await service.resume("session-a", cwd);
    await expect(service.create({ cwd, config: { model: "openrouter/openai/gpt-5.1", thinking: "ultra", skills: [], extensions: [] } })).resolves.toMatchObject({ code: "invalid_thinking" });
    await expect(service.state("session-a", cwd)).resolves.toMatchObject({ id: "session-a" });
    await service.shutdownAll();
  });

  it("does not execute a mutating command when preflight reconciliation fails", async () => {
    process.env.FAKE_PI_FAIL_STATE_AFTER = "1";
    const service = new NodeSessionService();
    const cwd = await workspaceWithSessions("session-a");
    await service.resume("session-a", cwd);
    await expect(service.fork("session-a", cwd)).resolves.toMatchObject({ success: false, code: "state_failed" });
    expect(await readFile(process.env.FAKE_PI_LOG!, "utf8")).not.toContain('"type":"clone"');
    await service.shutdownAll();
  });

  it("cleans a failed restart handshake, restores the old session, and publishes blank replacements", async () => {
    const service = new NodeSessionService();
    const cwd = await workspaceWithSessions("session-a");
    process.env.FAKE_PI_MODE = "restart-fail-once";
    await service.resume("session-a", cwd);
    await expect(service.reloadConfiguration()).rejects.toThrow("timeout");
    await expect(service.state("session-a", cwd)).resolves.toMatchObject({ id: "session-a" });
    await service.shutdownAll();

    process.env.FAKE_PI_MODE = "";
    const blankService = new NodeSessionService();
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
