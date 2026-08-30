// PiJsonRunner tests (docs §9.9, §14.2 Security rows). Fake manager/process
// objects drive the event flow without real processes, sleeps or network.
// The no-tool flag gate is the release assertion: args must contain
// --no-tools/--no-extensions/--no-skills and must not contain -e/--skill.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metadataRoot } from "../storage/persistence.js";
import { resetWebRuntimeAllocation } from "../runtime/pi/pi-runtime-launch.js";
import type { PiEvent, PiProcessOptions, PiResult } from "../runtime/pi/pi-process.js";
import { DEFAULT_MAX_RESPONSE_BYTES, PiJsonRunner, withoutToolCapabilityArgs } from "./pi-json-runner.js";

const cleanup: string[] = [];
const original = { home: process.env.PI_SCIENCE_HOME, cli: process.env.PI_CLI_PATH, mode: process.env.PI_SCIENCE_PI_MODE };

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-json-runner-home-"));
  cleanup.push(root);
  process.env.PI_SCIENCE_HOME = join(root, "control-home");
  process.env.PI_CLI_PATH = join(root, "fake-pi.mjs");
  delete process.env.PI_SCIENCE_PI_MODE;
  resetWebRuntimeAllocation();
});

afterEach(async () => {
  if (original.home === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = original.home;
  if (original.cli === undefined) delete process.env.PI_CLI_PATH;
  else process.env.PI_CLI_PATH = original.cli;
  if (original.mode === undefined) delete process.env.PI_SCIENCE_PI_MODE;
  else process.env.PI_SCIENCE_PI_MODE = original.mode;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

interface ScriptedTurn {
  text?: string;
  deltas?: string[];
  usage?: { input?: number; output?: number; cost?: { total?: number } };
  /** Default true; set false for a hung runtime that never settles. */
  settle?: boolean;
}

class FakePiProcess extends EventEmitter {
  readonly sent: Array<{ type: string; params: Record<string, unknown> }> = [];
  constructor(private readonly script: ScriptedTurn[]) {
    super();
  }
  async sendCommand(type: string, params: Record<string, unknown> = {}): Promise<PiResult> {
    this.sent.push({ type, params });
    const turnIndex = this.sent.filter((entry) => entry.type === "prompt").length - 1;
    if (type === "prompt") queueMicrotask(() => this.replay(turnIndex));
    return { success: true };
  }
  private replay(turnIndex: number): void {
    const turn = this.script[Math.min(turnIndex, this.script.length - 1)] ?? {};
    for (const delta of turn.deltas ?? []) this.emit("event", deltaEvent("text_delta", delta));
    if (turn.text) this.emit("event", deltaEvent("text", turn.text));
    if (turn.usage) this.emit("event", { type: "message_end", message: { usage: turn.usage } } as PiEvent);
    if (turn.settle !== false) this.emit("event", { type: "agent_settled" } as PiEvent);
  }
}

function deltaEvent(kind: string, value: string): PiEvent {
  return { type: "message_update", assistantMessageEvent: { type: kind, delta: value } };
}

class FakeManager {
  readonly optionsByKey = new Map<string, PiProcessOptions>();
  readonly stopCalls: string[] = [];
  constructor(private readonly script: ScriptedTurn[]) {}
  process(key: string): FakePiProcess | undefined {
    return this.children.get(key);
  }
  private readonly children = new Map<string, FakePiProcess>();
  async start(key: string, options: PiProcessOptions): Promise<FakePiProcess> {
    const child = new FakePiProcess(this.script);
    this.children.set(key, child);
    this.optionsByKey.set(key, options);
    return child;
  }
  async stop(key: string): Promise<void> {
    this.stopCalls.push(key);
  }
}

async function tempWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-json-runner-ws-"));
  cleanup.push(cwd);
  return cwd;
}

describe("withoutToolCapabilityArgs", () => {
  it("strips capability flag/value pairs and appends the three disable flags last", () => {
    expect(withoutToolCapabilityArgs(["--mode", "rpc", "--skill", "/ws/.pi/skills/x/SKILL.md", "-e", "/ext.ts", "--no-session"]))
      .toEqual(["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills"]);
    expect(withoutToolCapabilityArgs([])).toEqual(["--no-tools", "--no-extensions", "--no-skills"]);
  });
});

describe("PiJsonRunner", () => {
  it("launches with forced no-tool flags and an isolated scheduled session dir", async () => {
    const manager = new FakeManager([{ deltas: ['{"ok":', "true}"] }]);
    const runner = new PiJsonRunner({ manager });
    const cwd = await tempWorkspace();
    await runner.run(cwd, { managerKey: "satt_1", systemPrompt: "SYS", userPrompt: "USER" });
    const options = manager.optionsByKey.get("satt_1")!;
    for (const flag of ["--no-tools", "--no-extensions", "--no-skills"]) expect(options.args).toContain(flag);
    // No bash/web/file capability may reach the runtime: no extension or skill grants survive.
    expect(options.args).not.toContain("-e");
    expect(options.args).not.toContain("--extension");
    expect(options.args).not.toContain("--skill");
    // Isolated session dir under the workspace metadata root (docs §9.9).
    expect(options.web?.runtime.sessionDir).toBe(join(metadataRoot(cwd), "scheduled-sessions", "satt_1"));
    expect(options.web?.runtime.skillPolicy).toEqual({ mode: "none" });
    // System + user prompt both reach the model in one turn; no tools are offered.
    const prompt = manager.process("satt_1")!.sent.find((entry) => entry.type === "prompt")!.params.message as string;
    expect(prompt).toContain("SYS");
    expect(prompt).toContain("USER");
  });

  it("accumulates text across deltas and usage from message_end, returning parsed JSON", async () => {
    const manager = new FakeManager([
      { deltas: ["```json\n{", '"answer": "ok"}'], usage: { input: 7, output: 3, cost: { total: 0.5 } } },
    ]);
    const runner = new PiJsonRunner({ manager });
    const result = await runner.run(await tempWorkspace(), { managerKey: "satt_2", systemPrompt: "s", userPrompt: "u" });
    expect(result.parsed).toEqual({ answer: "ok" });
    expect(result.text).toContain('"answer": "ok"}');
    expect(result.usage).toEqual({ model_tokens: 10, cost_usd: 0.5 });
  });

  it("repairs invalid JSON exactly once before succeeding", async () => {
    const manager = new FakeManager([
      { text: "Sorry, I cannot comply with that request." },
      { deltas: ['{"repaired": true}'], usage: { input: 5, output: 5, cost: { total: 0.1 } } },
    ]);
    const runner = new PiJsonRunner({ manager });
    const result = await runner.run(await tempWorkspace(), { managerKey: "satt_3", systemPrompt: "s", userPrompt: "u" });
    expect(result.parsed).toEqual({ repaired: true });
    const prompts = manager.process("satt_3")!.sent.filter((entry) => entry.type === "prompt");
    expect(prompts).toHaveLength(2);
    expect(String(prompts[1]!.params.message)).toMatch(/not valid JSON/i);
  });

  it("fails when the second response is still not JSON", async () => {
    const manager = new FakeManager([{ text: "still not json" }, { text: "```json nope ```" }]);
    const runner = new PiJsonRunner({ manager });
    await expect(runner.run(await tempWorkspace(), { managerKey: "satt_4", systemPrompt: "s", userPrompt: "u" }))
      .rejects.toThrow(/did not return JSON/);
    expect(manager.stopCalls).toContain("satt_4");
  });

  it("rejects responses exceeding the byte limit and disposes the managed process", async () => {
    const manager = new FakeManager([{ deltas: ["x".repeat(200)] }]);
    const runner = new PiJsonRunner({ manager, maxResponseBytes: 64 });
    await expect(runner.run(await tempWorkspace(), { managerKey: "satt_5", systemPrompt: "s", userPrompt: "u" }))
      .rejects.toThrow(/exceeds 64 bytes/);
    expect(manager.stopCalls).toContain("satt_5");
  });

  it("enforces the wall-clock timeout with fake timers", async () => {
    vi.useFakeTimers();
    try {
      const manager = new FakeManager([{ settle: false }]); // hung runtime
      const runner = new PiJsonRunner({ manager, timeoutMs: 50 });
      const pending = runner.run(await tempWorkspace(), { managerKey: "satt_6", systemPrompt: "s", userPrompt: "u" });
      const expectation = expect(pending).rejects.toThrow(/timed out after 50 ms/);
      await vi.advanceTimersByTimeAsync(60);
      await expectation;
      expect(manager.stopCalls).toContain("satt_6");
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes the managed process when the abort signal fires", async () => {
    const controller = new AbortController();
    const manager = new FakeManager([{ settle: false }]);
    const runner = new PiJsonRunner({ manager });
    const cwd = await tempWorkspace();
    const pending = runner.run(cwd, { managerKey: "satt_7", systemPrompt: "s", userPrompt: "u", signal: controller.signal });
    const child = await vi.waitFor(() => {
      const proc = manager.process("satt_7");
      expect(proc).toBeDefined();
      return proc!;
    });
    await vi.waitFor(() => expect(child.sent.some((entry) => entry.type === "prompt")).toBe(true));
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(manager.stopCalls).toContain("satt_7");
  });

  it("documents the default response budget of 2 MiB", () => {
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(2 * 1024 * 1024);
  });
});
