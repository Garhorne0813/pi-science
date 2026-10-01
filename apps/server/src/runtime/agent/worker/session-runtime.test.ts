import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, type AgentLane, type AgentHarness, type NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { SessionRuntime } from "./session-runtime.js";

const roots: string[] = [];
const runtimes: SessionRuntime[] = [];
const context = BACKGROUND_CONTEXT;

async function runtime() {
  const cwd = resolve(await mkdtemp(join(tmpdir(), "pi-science-worker-mutations-")));
  roots.push(cwd);
  const instance = await SessionRuntime.open({ cwd, sessionsRoot: join(cwd, ".pi-science", "agent-sessions"),
    model: { provider: "openai", modelId: "gpt-4.1-mini" }, thinking: "low",
    env: { PATH: process.env.PATH ?? "", OPENAI_API_KEY: "model-test-secret", PI_SCIENCE_INTERNAL_TOKEN: "server-test-secret" },
  }, () => undefined, (error) => { throw error; });
  runtimes.push(instance);
  await instance.command("activate", {});
  return { instance, parts: instance as unknown as { lane: AgentLane; harness: AgentHarness; executionEnv: NodeExecutionEnv } };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.allSettled(runtimes.splice(0).map((instance) => instance.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent-core worker mutations", () => {
  it("rolls back a partial failure before another configuration can commit", async () => {
    const { instance, parts } = await runtime();
    const setThinking = parts.lane.setThinkingLevel.bind(parts.lane);
    vi.spyOn(parts.lane, "setThinkingLevel").mockImplementation(async (level, ctx) => {
      if (level === "medium") throw new Error("injected configuration failure");
      return setThinking(level, ctx);
    });
    const [failed, committed] = await Promise.all([
      instance.command("configure", { provider: "openai", modelId: "gpt-4.1", level: "medium" }),
      instance.command("configure", { provider: "openai", modelId: "gpt-4.1-mini", level: "high" }),
    ]);
    expect(failed).toMatchObject({ success: false });
    expect(committed).toMatchObject({ success: true });
    expect(await instance.command("get_state", {})).toMatchObject({ success: true,
      data: { model: { provider: "openai", modelId: "gpt-4.1-mini" }, thinkingLevel: "high" } });
  });

  it("validates the complete configuration before changing the durable lane", async () => {
    const { instance } = await runtime();
    expect(await instance.command("configure", { provider: "openai", modelId: "gpt-4.1", level: "invalid" }))
      .toMatchObject({ success: false, code: "invalid_thinking" });
    expect(await instance.command("set_model", { provider: "openai", modelId: "not-a-model" }))
      .toMatchObject({ success: false, code: "invalid_model" });
    expect(await instance.command("get_state", {})).toMatchObject({ success: true,
      data: { model: { provider: "openai", modelId: "gpt-4.1-mini" }, thinkingLevel: "low" } });
  });

  it("keeps abort reachable while a configuration mutation is waiting", async () => {
    const { instance, parts } = await runtime();
    let release!: () => void;
    const blocked = new Promise<void>((resolveGate) => { release = resolveGate; });
    const setThinking = parts.lane.setThinkingLevel.bind(parts.lane);
    const setter = vi.spyOn(parts.lane, "setThinkingLevel").mockImplementation(async (level, ctx) => {
      await blocked;
      return setThinking(level, ctx);
    });
    const configure = instance.command("configure", { provider: "openai", modelId: "gpt-4.1", level: "high" });
    try {
      await vi.waitFor(() => expect(setter).toHaveBeenCalled());
      expect(await instance.command("abort", {})).toMatchObject({ success: false }); // No active model operation.
    } finally { release(); }
    expect(await configure).toMatchObject({ success: true });
  });

  it("does not give ordinary bash processes model, server, or inherited credentials", async () => {
    vi.stubEnv("PR115_PARENT_SECRET", "parent-test-secret");
    const { parts } = await runtime();
    const bash = (await parts.harness.getTools(context)).find((tool) => tool.name === "bash")!;
    const script = "console.log(JSON.stringify({model:!!process.env.OPENAI_API_KEY,server:!!process.env.PI_SCIENCE_INTERNAL_TOKEN,parent:!!process.env.PR115_PARENT_SECRET,path:!!process.env.PATH}))";
    const command = `'${process.execPath.replaceAll("'", "'\\''")}' -e '${script}'`;
    const result = await bash.execute("environment-test", { command }, () => undefined,
      { env: parts.executionEnv }, {} as never, context);
    const text = result.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("");
    expect(JSON.parse(text.trim())).toEqual({ model: false, server: false, parent: false, path: true });
  });
});
