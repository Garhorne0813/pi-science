import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readJson, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";
import { AgentCoreSessionService } from "./agent-core-session-service.js";
import { CredentialStore } from "../../model-resources/credential-store.js";

describe("agent-core session configuration", () => {
  it("rejects model changes while the session is busy without touching the worker", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-busy-test"));
    const sessionId = "busy-session";
    const sendCommand = vi.fn();
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({} as never, {} as never);
    (service as unknown as { live: Map<string, unknown> }).live.set(`${cwd}\0${sessionId}`,
      { key: "test", runtime, busy: true, restartPending: false, model: "openai/old", thinking: "low" });
    expect(await service.configure(cwd, sessionId, "openai/new", "high", { skills: [], extensions: [] }))
      .toMatchObject({ success: false, code: "busy" });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("rejects a busy runtime snapshot before sending configuration mutations", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-busy-snapshot-test"));
    const sessionId = "busy-snapshot-session";
    const sendCommand = vi.fn().mockResolvedValue({ success: true, data: { busy: true } });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({} as never, {} as never);
    (service as unknown as { live: Map<string, unknown> }).live.set(`${cwd}\0${sessionId}`,
      { key: "test", runtime, busy: false, restartPending: false, model: "openai/old", thinking: "low" });
    expect(await service.configure(cwd, sessionId, "openai/new", "high", { skills: [], extensions: [] }))
      .toMatchObject({ success: false, code: "busy" });
    expect(sendCommand).toHaveBeenCalledExactlyOnceWith("get_state");
  });

  it("selects custom model and MCP credential names for the worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-core-env-"));
    const previousHome = process.env.PI_SCIENCE_HOME;
    const previousToken = process.env.MY_LAB_TOKEN;
    try {
      process.env.PI_SCIENCE_HOME = join(root, "home");
      process.env.MY_LAB_TOKEN = "test-secret";
      await new CredentialStore().put({ id: "lab", backend: "environment", environment_variable: "MY_LAB_TOKEN", kind: "api_key" });
      const cwd = join(root, "workspace");
      await mkdir(join(cwd, ".pi-science"), { recursive: true });
      await writeFile(join(cwd, ".pi-science", "mcp-runtime.json"), JSON.stringify({ version: 1, project_id: "project_test",
        mcpServers: { lab: { __piScienceEnvironment: { TOKEN: { kind: "environment", name: "MY_MCP_KEY" } } } } }));
      const service = new AgentCoreSessionService({} as never, {} as never);
      const names = await (service as unknown as { credentialEnvNames(cwd: string): Promise<string[]> }).credentialEnvNames(cwd);
      expect(names.sort()).toEqual(["MY_LAB_TOKEN", "MY_MCP_KEY"]);
    } finally {
      if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME; else process.env.PI_SCIENCE_HOME = previousHome;
      if (previousToken === undefined) delete process.env.MY_LAB_TOKEN; else process.env.MY_LAB_TOKEN = previousToken;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores runtime and keeps saved configuration when changing thinking fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-config-"));
    try {
      const sessionId = "session-test";
      const path = workspaceFile(cwd, `agent-session-config/${createHash("sha256").update(sessionId).digest("hex")}.json`);
      await writeJsonAtomic(path, { model: "openai/old", thinking: "low", skills: ["lab"] });
      const state = { model: { provider: "openai", modelId: "old" }, thinkingLevel: "low" };
      const commands: string[] = [];
      let rejectThinking = true;
      const runtime = { cwd, sessionId, isClosed: false, sendCommand: async (name: string, params?: Record<string, string>) => {
        commands.push(name);
        if (name === "get_state") return { success: true, data: structuredClone(state) };
        if (name === "set_model") { state.model = { provider: params!.provider!, modelId: params!.modelId! }; return { success: true }; }
        if (name === "set_thinking_level") {
          if (rejectThinking) { rejectThinking = false; return { success: false, code: "rejected", error: "thinking rejected" }; }
          state.thinkingLevel = params!.level!;
          return { success: true };
        }
        throw new Error(`unexpected command: ${name}`);
      } };
      const service = new AgentCoreSessionService({} as never, {} as never);
      const live = { key: "test", runtime, busy: false, restartPending: false, model: "openai/old", thinking: "low" };
      (service as unknown as { live: Map<string, unknown> }).live.set(`${resolve(cwd)}\0${sessionId}`, live);
      const config = { skills: [], extensions: [] };
      const result = await service.configure(cwd, sessionId, "openai/new", "high", config);
      expect(result).toMatchObject({ success: false, code: "rejected" });
      expect(state).toEqual({ model: { provider: "openai", modelId: "old" }, thinkingLevel: "low" });
      expect(live).toMatchObject({ model: "openai/old", thinking: "low" });
      expect(await readJson(path, null)).toEqual({ model: "openai/old", thinking: "low", skills: ["lab"] });
      expect(commands).toEqual(["get_state", "set_model", "set_thinking_level", "set_model", "set_thinking_level", "get_state"]);
      expect(await service.configure(cwd, sessionId, "openai/new", "invalid", config)).toMatchObject({ success: false, code: "invalid_thinking" });
      expect(commands).toHaveLength(6);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("restores runtime when the configuration file cannot be persisted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-config-write-"));
    try {
      const sessionId = "session-write-test";
      const path = workspaceFile(cwd, `agent-session-config/${createHash("sha256").update(sessionId).digest("hex")}.json`);
      await mkdir(path, { recursive: true }); // A directory at the file path makes atomic rename fail.
      const state = { model: { provider: "openai", modelId: "old" }, thinkingLevel: "low" };
      const runtime = { cwd, sessionId, isClosed: false, sendCommand: async (name: string, params?: Record<string, string>) => {
        if (name === "get_state") return { success: true, data: structuredClone(state) };
        if (name === "set_model") { state.model = { provider: params!.provider!, modelId: params!.modelId! }; return { success: true }; }
        if (name === "set_thinking_level") { state.thinkingLevel = params!.level!; return { success: true }; }
        throw new Error(`unexpected command: ${name}`);
      } };
      const service = new AgentCoreSessionService({} as never, {} as never);
      const live = { key: "test", runtime, busy: false, restartPending: false, model: "openai/old", thinking: "low" };
      (service as unknown as { live: Map<string, unknown> }).live.set(`${resolve(cwd)}\0${sessionId}`, live);
      expect(await service.configure(cwd, sessionId, "openai/new", "high", { skills: [], extensions: [] }))
        .toMatchObject({ success: false, code: "agent_runtime_error" });
      expect(state).toEqual({ model: { provider: "openai", modelId: "old" }, thinkingLevel: "low" });
      expect(live).toMatchObject({ model: "openai/old", thinking: "low" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
