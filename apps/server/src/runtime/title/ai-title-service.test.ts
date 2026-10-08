import { CredentialStore } from "../../model-resources/credential-store.js";
import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiTitleService, aiTitlesEnabled, cleanTitle, CoreTitleRuntimeFactory, type TitleRuntime } from "./ai-title-service.js";

const cleanups: string[] = [];

async function makeSession(cwd: string, sessionId: string, rows: Array<{ role: string; text: string }>) {
  const root = join(cwd, ".pi-science", "sessions");
  await mkdir(root, { recursive: true });
  const file = join(root, `${sessionId}.jsonl`);
  const header = JSON.stringify({
    id: sessionId,
    type: "session",
    cwd,
    timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  });
  const lines = rows.map((row, index) => JSON.stringify({
    id: `${sessionId}-${index}`,
    type: "message",
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
    message: { role: row.role, content: [{ type: "text", text: row.text }] },
  }));
  await writeFile(file, [header, ...lines].join("\n"));
  return file;
}

/** Fake runtime: scripted prompt acceptance and poll replies. */
function fakeRuntime(script: Array<{ type: string; text?: string; success?: boolean }>, disposeCount: { count: number }): TitleRuntime {
  let promptCount = 0;
  let pollCount = 0;
  return {
    async sendCommand(type, _params) {
      if (type === "prompt") {
        promptCount += 1;
        const entry = script.find((item) => item.type === "prompt");
        return entry?.success === false ? { success: false, code: "rejected", error: "nope" } : { success: true };
      }
      if (type === "get_last_assistant_text") {
        const entry = script.find((item) => item.type === `poll${pollCount}`);
        pollCount += 1;
        if (entry?.success === false) return { success: false, code: "transport_error", error: "gone" };
        const text = entry?.text ?? "";
        return { success: true, data: { text } };
      }
      return { success: false, code: "unsupported_command", error: `unsupported: ${type}` };
    },
    async dispose() {
      disposeCount.count += 1;
    },
  };
}

describe("cleanTitle", () => {
  it("strips quotes, labels, newlines and collapses whitespace", () => {
    expect(cleanTitle('  "单细胞数据 QC 分析"  ')).toBe("单细胞数据 QC 分析");
    expect(cleanTitle("Title: RNA-seq 差异表达\n分析")).toBe("RNA-seq 差异表达 分析");
    expect(cleanTitle("「蛋白质结构预测」")).toBe("蛋白质结构预测");
  });

  it("rejects empty or over-long results", () => {
    expect(cleanTitle("   ")).toBeNull();
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle("x".repeat(51))).toBeNull();
    expect(cleanTitle("x".repeat(50))).toBe("x".repeat(50));
  });
});

describe("AiTitleService", () => {
  let cwd: string;
  let sessionId: string;
  let disposed: { count: number };

  beforeEach(async () => {
    cwd = join(tmpdir(), `pi-science-title-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(cwd, { recursive: true });
    vi.stubEnv("PI_SCIENCE_HOME", join(cwd, "home"));
    sessionId = `sess-${Math.random().toString(16).slice(2)}`;
    disposed = { count: 0 };
    cleanups.push(cwd);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env.PI_SCIENCE_AI_TITLES = undefined;
  });

  it("returns null when the AI-title env flag disables the feature", () => {
    expect(aiTitlesEnabled()).toBe(true);
    process.env.PI_SCIENCE_AI_TITLES = "0";
    expect(aiTitlesEnabled()).toBe(false);
  });


  it("disposes the title runtime through manager.stop so the process map does not leak", async () => {
    const stopped: string[] = [];
    let runtimeSessionDir = "";
    let childId = "";
    const declaredCredentials: string[] = [];
    const manager = {
      async start(key: string, options: { sessionsRoot: string; credentialEnvNames: string[]; sessionId: string }) {
        runtimeSessionDir = options.sessionsRoot;
        childId = options.sessionId;
        declaredCredentials.push(...options.credentialEnvNames);
        return { sendCommand: async () => ({ success: true, data: null }), shutdown: async () => {} };
      },
      async stop(key: string) {
        stopped.push(key);
      },
    };
    const { configPath, writeJsonAtomic } = await import("../../storage/persistence.js");
    await writeJsonAtomic(configPath("config.json"), { model: "openai/gpt-4.1-mini" });
    await new CredentialStore().put({ kind: "api_key", backend: "environment", environment_variable: "LAB_TITLE_TOKEN" });
    const factory = new CoreTitleRuntimeFactory(manager as never, { environment: async () => ({}) } as never);
    const runtime = await factory.start(cwd);
    expect(declaredCredentials).toEqual(["LAB_TITLE_TOKEN"]);
    expect(runtimeSessionDir).toBe(join(cwd, ".pi-science", "agent-sessions"));
    expect(runtimeSessionDir).not.toBe(join(cwd, ".pi-science", "sessions"));
    const { AgentSessionRepository } = await import("../agent/agent-session-repository.js");
    const { SessionRepository } = await import("../node/session-repository.js");
    const target = await new AgentSessionRepository().findPath(cwd, childId);
    expect(target).toBeTruthy();
    expect(await new SessionRepository().list(cwd)).toEqual([]);
    await expect(access(target!)).resolves.toBeUndefined();
    await runtime.dispose();
    expect(stopped).toHaveLength(1);
    await expect(access(target!)).rejects.toThrow();
    expect(await new SessionRepository().list(cwd)).toEqual([]);
  });

  it("starts a real hidden Core worker and removes its transcript on shutdown", async () => {
    const { configPath, writeJsonAtomic } = await import("../../storage/persistence.js");
    const { SessionRepository } = await import("../node/session-repository.js");
    const { readdir } = await import("node:fs/promises");
    await writeJsonAtomic(configPath("config.json"), { model: "openai/gpt-4.1-mini" });
    const factory = new CoreTitleRuntimeFactory(undefined, { environment: async () => ({}) } as never);
    try {
      const runtime = await factory.start(cwd);
      const state = await runtime.sendCommand("get_state");
      expect(state).toMatchObject({ success: true, data: { activeTools: [], busy: false } });
      expect(await runtime.sendCommand("get_skills")).toMatchObject({ success: true, data: { skills: [] } });
      const { AgentSessionRepository } = await import("../agent/agent-session-repository.js");
      const target = await new AgentSessionRepository().findPath(cwd, String((state.data as { sessionId: string }).sessionId));
      expect(target).toBeTruthy();
      expect(await new SessionRepository().list(cwd)).toEqual([]);
      await factory.shutdownAll();
      await runtime.dispose();
      await expect(access(target!)).rejects.toThrow();
      expect(await new SessionRepository().list(cwd)).toEqual([]);
      expect(await readdir(join(cwd, ".pi-science", "agent-task-links"))).toEqual([]);
      await expect(factory.start(cwd)).rejects.toThrow("closing");
    } finally { await factory.shutdownAll(); }
  }, 30_000);

  it("generates a title from the latest messages and disposes the runtime", async () => {
    await makeSession(cwd, sessionId, [
      { role: "user", text: "帮我分析这个单细胞数据" },
      { role: "assistant", text: "我先看一下数据。" },
      { role: "user", text: "做下质控" },
    ]);
    const service = new AiTitleService(
      { start: async () => fakeRuntime([{ type: "prompt" }, { type: "poll0", text: '"单细胞数据 QC 分析"' }], disposed) },
    );
    await expect(service.generateTitle(cwd, sessionId)).resolves.toBe("单细胞数据 QC 分析");
    expect(disposed.count).toBe(1);
  });

  it("polls until the reply appears (empty replies first)", async () => {
    await makeSession(cwd, sessionId, [{ role: "user", text: "hi" }]);
    const service = new AiTitleService(
      { start: async () => fakeRuntime([{ type: "prompt" }, { type: "poll0", text: "" }, { type: "poll1", text: "Quick reply" }], disposed) },
    );
    await expect(service.generateTitle(cwd, sessionId)).resolves.toBe("Quick reply");
    expect(disposed.count).toBe(1);
  });

  it("returns null when the reply is over-long instead of polling the budget", async () => {
    await makeSession(cwd, sessionId, [{ role: "user", text: "hi" }]);
    // If the service kept polling, poll1's clean title would be returned;
    // returning null proves the over-long reply short-circuited the loop.
    const service = new AiTitleService(
      { start: async () => fakeRuntime([{ type: "prompt" }, { type: "poll0", text: "x".repeat(51) }, { type: "poll1", text: "Valid title" }], disposed) },
    );
    await expect(service.generateTitle(cwd, sessionId)).resolves.toBeNull();
    expect(disposed.count).toBe(1);
  });

  it("returns null when disabled", async () => {
    process.env.PI_SCIENCE_AI_TITLES = "0";
    await makeSession(cwd, sessionId, [{ role: "user", text: "hi" }]);
    const service = new AiTitleService({ start: async () => fakeRuntime([{ type: "prompt" }], disposed) });
    await expect(service.generateTitle(cwd, sessionId)).resolves.toBeNull();
    expect(disposed.count).toBe(0);
  });

  it("returns null when the session has no user/assistant messages", async () => {
    await makeSession(cwd, sessionId, [{ role: "system", text: "be nice" }]);
    const service = new AiTitleService({ start: async () => fakeRuntime([{ type: "prompt" }], disposed) });
    await expect(service.generateTitle(cwd, sessionId)).resolves.toBeNull();
    expect(disposed.count).toBe(0);
  });

  it("returns null when the prompt is rejected and still disposes", async () => {
    await makeSession(cwd, sessionId, [{ role: "user", text: "hi" }]);
    const service = new AiTitleService(
      { start: async () => fakeRuntime([{ type: "prompt", success: false }], disposed) },
    );
    await expect(service.generateTitle(cwd, sessionId)).resolves.toBeNull();
    expect(disposed.count).toBe(1);
  });

  it("returns null on transport error during polling and still disposes", async () => {
    await makeSession(cwd, sessionId, [{ role: "user", text: "hi" }]);
    const service = new AiTitleService(
      { start: async () => fakeRuntime([{ type: "prompt" }, { type: "poll0", success: false }], disposed) },
    );
    await expect(service.generateTitle(cwd, sessionId)).resolves.toBeNull();
    expect(disposed.count).toBe(1);
  });

  it("deduplicates concurrent calls for the same session (single runtime)", async () => {
    await makeSession(cwd, sessionId, [{ role: "user", text: "hi" }]);
    let starts = 0;
    const service = new AiTitleService({
      start: async () => {
        starts += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return fakeRuntime([{ type: "prompt" }, { type: "poll0", text: "Same title" }], disposed);
      },
    });
    const [first, second] = await Promise.all([
      service.generateTitle(cwd, sessionId),
      service.generateTitle(cwd, sessionId),
    ]);
    expect(first).toBe("Same title");
    expect(second).toBe("Same title");
    expect(starts).toBe(1);
    expect(disposed.count).toBe(1);
  });

  it("times out when the runtime never replies and still disposes", async () => {
    await makeSession(cwd, sessionId, [{ role: "user", text: "hi" }]);
    const service = new AiTitleService(
      { start: async () => fakeRuntime([{ type: "prompt" }, { type: "poll0", text: "" }, { type: "poll1", text: "" }], disposed) },
      true,
      1,
      10,
    );
    await expect(service.generateTitle(cwd, sessionId)).resolves.toBeNull();
    expect(disposed.count).toBe(1);
  });
});
