import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readJson, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";
import { AgentCoreSessionService } from "./agent-core-session-service.js";
import { workspaceIdentity } from "./workspace-session-identity.js";
import { CredentialStore } from "../../model-resources/credential-store.js";
import { AgentRuntimeExitedError, AgentRuntimeTimeoutError } from "./agent-runtime-errors.js";
import { EventEmitter } from "node:events";

describe("agent-core session configuration", () => {
  it("rejects model changes while the session is busy without touching the worker", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-busy-test"));
    const sessionId = "busy-session";
    const sendCommand = vi.fn();
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({} as never, {} as never);
    (service as unknown as { live: Map<string, unknown> }).live.set(`${workspaceIdentity(cwd)}\0${sessionId}`,
      { key: "test", runtime, busy: true, restartPending: false, model: "openai/old", thinking: "low" });
    expect(await service.configure(cwd, sessionId, "openai/new", "high", { skills: [], extensions: [] }))
      .toMatchObject({ success: false, code: "busy" });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("preserves a worker's authoritative busy rejection", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-busy-snapshot-test"));
    const sessionId = "busy-snapshot-session";
    const sendCommand = vi.fn().mockResolvedValue({ success: false, code: "busy" });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({} as never, {} as never);
    (service as unknown as { live: Map<string, unknown> }).live.set(`${workspaceIdentity(cwd)}\0${sessionId}`,
      { key: "test", runtime, busy: false, restartPending: false, model: "openai/old", thinking: "low" });
    expect(await service.configure(cwd, sessionId, "openai/new", "high", { skills: [], extensions: [] }))
      .toMatchObject({ success: false, code: "busy" });
    expect(sendCommand).toHaveBeenCalledExactlyOnceWith("configure", { provider: "openai", modelId: "new", level: "high" });
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

  it("serializes configuration requests and never sends an old host rollback", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-config-"));
    try {
      const sessionId = "session-test";
      const path = workspaceFile(cwd, `agent-session-config/${createHash("sha256").update(sessionId).digest("hex")}.json`);
      await writeJsonAtomic(path, { model: "openai/old", thinking: "low", skills: ["lab"] });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const sendCommand = vi.fn(async (_name: string, params: Record<string, string>) => {
        if (params.modelId === "first") { await blocked; return { success: false, code: "invalid_model" }; }
        return { success: true, data: { model: { provider: params.provider, modelId: params.modelId }, thinkingLevel: params.level } };
      });
      const runtime = { cwd, sessionId, isClosed: false, sendCommand };
      const service = new AgentCoreSessionService({} as never, {} as never);
      const live = { key: "test", runtime, busy: false, restartPending: false, model: "openai/old", thinking: "low" };
      (service as unknown as { live: Map<string, unknown> }).live.set(`${workspaceIdentity(cwd)}\0${sessionId}`, live);
      const config = { skills: [], extensions: [] };
      const first = service.configure(cwd, sessionId, "openai/first", "medium", config);
      const second = service.configure(cwd, sessionId, "openai/second", "high", config);
      await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(1));
      release();
      expect(await first).toMatchObject({ success: false, code: "invalid_model" });
      expect(await second).toMatchObject({ success: true, model: "openai/second", thinking: "high" });
      expect(live).toMatchObject({ model: "openai/second", thinking: "high" });
      expect(sendCommand.mock.calls.map(([name]) => name)).toEqual(["configure", "configure"]);
      // Stale sidecar cache values no longer participate in configuration.
      expect(await readJson(path, null)).toEqual({ model: "openai/old", thinking: "low", skills: ["lab"] });
      expect(await service.configure(cwd, sessionId, "openai/new", "invalid", config)).toMatchObject({ success: false, code: "invalid_thinking" });
      expect(sendCommand).toHaveBeenCalledTimes(2);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("keeps durable worker configuration authoritative when the sidecar cannot be written", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-config-write-"));
    try {
      const sessionId = "session-write-test";
      const path = workspaceFile(cwd, `agent-session-config/${createHash("sha256").update(sessionId).digest("hex")}.json`);
      await mkdir(path, { recursive: true }); // A directory at the file path makes atomic rename fail.
      const runtime = { cwd, sessionId, isClosed: false, sendCommand: async () => ({ success: true,
        data: { model: { provider: "openai", modelId: "new" }, thinkingLevel: "high" } }) };
      const service = new AgentCoreSessionService({} as never, {} as never);
      const live = { key: "test", runtime, busy: false, restartPending: false, model: "openai/old", thinking: "low" };
      (service as unknown as { live: Map<string, unknown> }).live.set(`${workspaceIdentity(cwd)}\0${sessionId}`, live);
      expect(await service.configure(cwd, sessionId, "openai/new", "high", { skills: [], extensions: [] }))
        .toMatchObject({ success: true, model: "openai/new", thinking: "high" });
      expect(live).toMatchObject({ model: "openai/new", thinking: "high" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it.each([
    [new AgentRuntimeTimeoutError("prompt", 30_000), "timeout"],
    [new AgentRuntimeExitedError("worker exited after accepting prompt"), "process_exit"],
  ])("preserves ambiguous transport failures: %s", async (error, code) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-transport-"));
    try {
      const runtime = { cwd, sessionId: "transport", isClosed: false, sendCommand: vi.fn().mockRejectedValue(error) };
      const service = new AgentCoreSessionService({} as never, {} as never);
      const recover = vi.spyOn(service as unknown as { recover(item: unknown): Promise<void> }, "recover").mockResolvedValue();
      (service as unknown as { live: Map<string, unknown> }).live.set(`${workspaceIdentity(cwd)}\0transport`,
        { key: "test", runtime, busy: false, restartPending: false, model: "openai/old", thinking: "low" });
      expect(await service.command(cwd, "transport", "prompt", { message: "hello" }, { skills: [], extensions: [] }))
        .toMatchObject({ success: false, code });
      expect(recover).toHaveBeenCalledOnce();
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("applies the initial snapshot before activation events change busy state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-attach-"));
    try {
      const runtime = Object.assign(new EventEmitter(), { cwd, sessionId: "recovered", isClosed: false,
        sendCommand: async (command: string) => {
          if (command === "get_state") return { success: true, data: { busy: true } };
          runtime.emit("event", { type: "agent_start", runId: "recovery", turnId: "recovery" });
          runtime.emit("event", { type: "agent_settled", runId: "recovery" });
          return { success: true };
        } });
      const hub = { bind: (_cwd: string, source: EventEmitter, callbacks: { onBusy(busy: boolean): void }) => {
        source.on("event", (event: { type: string }) => {
          if (event.type === "agent_start") callbacks.onBusy(true);
          if (event.type === "agent_settled") callbacks.onBusy(false);
        });
      } };
      const service = new AgentCoreSessionService(hub as never, {} as never);
      const live = await (service as unknown as { attach(key: string, runtime: unknown, model: string, level: string): Promise<{ busy: boolean }> })
        .attach("test", runtime, "openai/old", "low");
      expect(live.busy).toBe(false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("waits for activation before aborting a partially attached recovery", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-opening-"));
    try {
      const sessionId = "opening-recovery";
      const runtime = { cwd, sessionId, isClosed: false, sendCommand: vi.fn().mockResolvedValue({ success: true }) };
      const live = { key: "test", runtime, busy: true, restartPending: false, model: "openai/old", thinking: "low" };
      const service = new AgentCoreSessionService({} as never, {} as never);
      const internals = service as unknown as { live: Map<string, typeof live>; opening: Map<string, Promise<typeof live>>;
        registry: { get(cwd: string, sessionId: string): Promise<unknown> } };
      const lookup = vi.spyOn(internals.registry, "get").mockResolvedValue(undefined);
      let activate!: (value: typeof live) => void;
      const opening = new Promise<typeof live>((resolveOpening) => { activate = resolveOpening; });
      const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
      internals.live.set(key, live);
      internals.opening.set(key, opening);
      const aborted = service.command(cwd, sessionId, "abort", {}, { skills: [], extensions: [] });
      try {
        await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        expect(runtime.sendCommand).not.toHaveBeenCalled();
      } finally { activate(live); lookup.mockRestore(); }
      expect(await aborted).toMatchObject({ success: true });
      expect(runtime.sendCommand).toHaveBeenCalledExactlyOnceWith("abort", {});
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
