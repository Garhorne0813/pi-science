import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJson, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";
import { AgentCoreSessionService } from "./agent-core-session-service.js";
import { workspaceIdentity } from "./workspace-session-identity.js";
import { CredentialStore } from "../../model-resources/credential-store.js";
import { AgentRuntimeCapacityError, AgentRuntimeExitedError, AgentRuntimeTimeoutError } from "./agent-runtime-errors.js";
import { isPromptDeliveryIndeterminate } from "../node/prompt-request-repository.js";
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

  it("reports readiness only once a conversion has finished", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-ready-test"));
    const sessionId = "ready-session";
    const service = new AgentCoreSessionService({} as never, {} as never);
    const internals = service as unknown as { migrating: Set<string>; owns: () => Promise<boolean> };
    internals.owns = async () => true;
    expect(await service.ready(cwd, sessionId)).toBe(true);
    internals.migrating.add(`${workspaceIdentity(cwd)}\0${sessionId}`);
    expect(await service.ready(cwd, sessionId)).toBe(false);
  });

  it("classifies a capacity rejection as definite so the prompt ledger can retry", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-capacity-test"));
    const sessionId = "capacity-session";
    const sendCommand = vi.fn().mockRejectedValue(new AgentRuntimeCapacityError("Agent worker capacity limit reached"));
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({} as never, {} as never);
    (service as unknown as { live: Map<string, unknown> }).live.set(`${workspaceIdentity(cwd)}\0${sessionId}`,
      { key: "test", runtime, busy: false, restartPending: false, model: "openai/old", thinking: "low" });
    const result = await service.command(cwd, sessionId, "abort", {}, { skills: [], extensions: [] });
    // Nothing was dispatched, so the request must stay retryable rather than
    // being recorded as an ambiguous delivery.
    expect(result).toMatchObject({ success: false, code: "runtime_capacity_exceeded" });
    expect(isPromptDeliveryIndeterminate("runtime_capacity_exceeded")).toBe(false);
  });

  it("keeps the capacity classification when creating a session", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-create-capacity-test"));
    const service = new AgentCoreSessionService({} as never, {} as never);
    service.configureBeforeStart(async () => { throw new AgentRuntimeCapacityError("Agent worker capacity limit reached"); });
    // One capacity condition must not answer 429 when reopening a session and
    // 503 when creating one.
    await expect(service.create(cwd, { model: "openai/gpt-4.1-mini", skills: [], extensions: [] }))
      .resolves.toMatchObject({ code: "runtime_capacity_exceeded" });
  });

  it("keeps the deferred model when a reload's configure fails", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-reload-test"));
    const sessionId = "reload-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const sendCommand = vi.fn();
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; stopForReload: (item: unknown) => Promise<void> };
    const item = { key: "test", runtime, busy: true, restartPending: false, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, pendingModel: undefined as { model: string; thinking: string } | undefined };
    internals.live.set(key, item);
    await service.reloadConfiguration({ model: "openai/new", thinking: "high" });
    expect(item).toMatchObject({ restartPending: true, pendingModel: { model: "openai/new", thinking: "high" } });

    item.busy = false;
    sendCommand.mockResolvedValue({ success: false, code: "reconcile_failed", error: "inconsistent configuration" });
    await expect(internals.stopForReload(item)).rejects.toThrow("inconsistent configuration");
    expect(item).toMatchObject({ restartPending: true, pendingModel: { model: "openai/new", thinking: "high" } });
    expect(internals.live.has(key)).toBe(true);

    // A worker that answers with a different configuration must not tear itself
    // down from inside its own configure, and must not clear the target either.
    sendCommand.mockResolvedValue({ success: true, data: { model: { provider: "openai", modelId: "other" }, thinkingLevel: "low" } });
    await expect(internals.stopForReload(item)).rejects.toThrow("inconsistent configuration");
    expect(item).toMatchObject({ restartPending: true, pendingModel: { model: "openai/new", thinking: "high" } });
    expect(internals.live.has(key)).toBe(true);

    sendCommand.mockResolvedValue({ success: true, data: { model: { provider: "openai", modelId: "new" }, thinkingLevel: "high" } });
    await internals.stopForReload(item);
    expect(item.restartPending).toBe(false);
    expect(item.pendingModel).toBeUndefined();
    expect(internals.live.has(key)).toBe(false);
  });

  it("fails a prompt rather than sending it to the provider a failed reload left behind", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-reload-prompt-"));
    await mkdir(workspaceFile(cwd, "turn-lifecycle"), { recursive: true });
    const sessionId = "reload-prompt-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const sendCommand = vi.fn().mockImplementation(async (type: string) => type === "configure"
      ? { success: false, code: "reconcile_failed", error: "inconsistent configuration" }
      : { success: true, data: {} });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown> };
    const item = { key: "test", runtime, busy: false, restartPending: true, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, pendingModel: { model: "openai/new", thinking: "high" } as { model: string; thinking: string } | undefined };
    internals.live.set(key, item);
    const result = await service.command(cwd, sessionId, "prompt", { message: "hello" }, { skills: [], extensions: [] });
    // The caller answers the worker's own failure code, not a blanket reload code.
    expect(result).toMatchObject({ success: false, code: "reconcile_failed" });
    expect(sendCommand).not.toHaveBeenCalledWith("prompt", expect.anything());
    expect(item).toMatchObject({ restartPending: true, pendingModel: { model: "openai/new", thinking: "high" } });
    await rm(cwd, { recursive: true, force: true });
  });

  it("keeps the prompt guard armed when an idle session's reload fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-idle-reload-"));
    await mkdir(workspaceFile(cwd, "turn-lifecycle"), { recursive: true });
    const sessionId = "idle-reload-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const sendCommand = vi.fn().mockImplementation(async (type: string) => type === "configure"
      ? { success: false, code: "reconcile_failed", error: "inconsistent configuration" }
      : { success: true, data: {} });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown> };
    const item = { key: "test", runtime, busy: false, restartPending: false, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, pendingModel: undefined as { model: string; thinking: string } | undefined };
    internals.live.set(key, item);

    await expect(service.reloadConfiguration({ model: "openai/new", thinking: "high" })).rejects.toThrow("inconsistent configuration");
    // An idle session never had restartPending set by the reload itself, so the
    // guard has to come from the attempt, or the next prompt bypasses it entirely.
    expect(item).toMatchObject({ restartPending: true, pendingModel: { model: "openai/new", thinking: "high" } });

    const result = await service.command(cwd, sessionId, "prompt", { message: "hello" }, { skills: [], extensions: [] });
    expect(result).toMatchObject({ success: false, code: "reconcile_failed" });
    expect(sendCommand).not.toHaveBeenCalledWith("prompt", expect.anything());
    await rm(cwd, { recursive: true, force: true });
  });

  it("makes a prompt wait for an in-flight reload and inherit its failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-inflight-reload-"));
    await mkdir(workspaceFile(cwd, "turn-lifecycle"), { recursive: true });
    const sessionId = "inflight-reload-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sendCommand = vi.fn().mockImplementation(async (type: string) => {
      if (type !== "configure") return { success: true, data: {} };
      await gate;
      return { success: false, code: "reconcile_failed", error: "inconsistent configuration" };
    });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; stopForReload: (item: unknown) => Promise<void> };
    const item = { key: "test", runtime, busy: false, restartPending: true, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, pendingModel: { model: "openai/new", thinking: "high" } as { model: string; thinking: string } | undefined };
    internals.live.set(key, item);

    const reload = internals.stopForReload(item).catch(() => undefined);
    await vi.waitFor(() => { expect(sendCommand).toHaveBeenCalledWith("configure", expect.anything()); });
    // The prompt arrives while configure is still awaiting. It must not race past
    // the reload and reach the worker that still holds the replaced model.
    const prompt = service.command(cwd, sessionId, "prompt", { message: "hello" }, { skills: [], extensions: [] });
    release();
    await reload;
    expect(await prompt).toMatchObject({ success: false, code: "reconcile_failed" });
    expect(sendCommand).not.toHaveBeenCalledWith("prompt", expect.anything());
    await rm(cwd, { recursive: true, force: true });
  });

  it("re-checks the model change after preparing a prompt and before dispatching it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-dispatch-reload-"));
    await mkdir(workspaceFile(cwd, "turn-lifecycle"), { recursive: true });
    const sessionId = "dispatch-reload-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const sendCommand = vi.fn().mockResolvedValue({ success: true, data: {} });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; turns: unknown };
    const item = { key: "test", runtime, busy: false, restartPending: false, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, pendingModel: undefined as { model: string; thinking: string } | undefined };
    internals.live.set(key, item);
    // A settings save lands while preparation is awaiting, which is after the
    // guard has already run and before the prompt is dispatched.
    internals.turns = { prepare: async () => { item.pendingModel = { model: "openai/new", thinking: "high" }; },
      discardRejected: async () => undefined };

    const result = await service.command(cwd, sessionId, "prompt", { message: "hello" }, { skills: [], extensions: [] });
    expect(result).toMatchObject({ success: false, code: "configuration_reload_failed" });
    expect(sendCommand).not.toHaveBeenCalledWith("prompt", expect.anything());
    await rm(cwd, { recursive: true, force: true });
  });

  it("keeps the record when the worker exits while a model change is outstanding", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-exit-reload-test"));
    const sessionId = "exit-reload-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const sendCommand = vi.fn().mockImplementation(async (type: string, params: Record<string, unknown>) =>
      type === "configure"
        ? { success: true, data: { model: { provider: params.provider, modelId: params.modelId }, thinkingLevel: params.level } }
        : { success: true, data: {} });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; manager: { stop: (key: string) => Promise<void> };
      dropIfSettled: (item: unknown) => void; stopForReload: (item: unknown) => Promise<void> };
    const item = { key: "test", runtime, busy: false, restartPending: true, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, pendingModel: { model: "openai/b", thinking: "high" } as { model: string; thinking: string } | undefined };
    internals.live.set(key, item);
    // The exit handler runs in the middle of the stop, before the change that
    // lands during the same stop. Dropping the record there takes the change with
    // it, so the handler defers to the same rule the reload uses.
    internals.manager = { stop: async () => { internals.dropIfSettled(item); item.pendingModel = { model: "openai/c", thinking: "high" }; } };

    await internals.stopForReload(item);

    expect(internals.live.has(key)).toBe(true);
    expect(item).toMatchObject({ restartPending: true, pendingModel: { model: "openai/c", thinking: "high" } });
  });

  it("drains to the newest model change when one arrives during an awaiting configure", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-reload-race-test"));
    const sessionId = "reload-race-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sendCommand = vi.fn().mockImplementation(async (type: string, params: Record<string, unknown>) => {
      if (type !== "configure") return { success: true, data: {} };
      await gate;
      return { success: true, data: { model: { provider: params.provider, modelId: params.modelId }, thinkingLevel: params.level } };
    });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; stopForReload: (item: unknown) => Promise<void> };
    const item = { key: "test", runtime, busy: false, restartPending: false, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, pendingModel: { model: "openai/b", thinking: "high" } as { model: string; thinking: string } | undefined };
    internals.live.set(key, item);

    const first = internals.stopForReload(item);
    await vi.waitFor(() => { expect(sendCommand).toHaveBeenCalledWith("configure", expect.anything()); });
    const second = service.reloadConfiguration({ model: "openai/c", thinking: "high" });
    await vi.waitFor(() => { expect(item.pendingModel).toMatchObject({ model: "openai/c" }); });
    release();
    await first;
    await second;

    // The newest target is applied, not merely retained, and the boundary the
    // prompt waits on is clear by the time the reload resolves.
    expect(item).toMatchObject({ model: "openai/c", restartPending: false });
    expect(item.pendingModel).toBeUndefined();
    expect(internals.live.has(key)).toBe(false);
  });

  it("marks a recovered compaction as handled so it is not reported as an empty reply", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-recovered-compaction-test"));
    const sessionId = "recovered-compaction-session";
    const emitted: Array<Record<string, unknown>> = [];
    const sendCommand = vi.fn().mockResolvedValue({ success: true, data: { busy: false, eventSequence: 0,
      lastResult: { operationId: "compact-1", kind: "compaction", status: "completed" } } });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand,
      emit: (_name: string, value: Record<string, unknown>) => { emitted.push(value); } };
    const service = new AgentCoreSessionService({} as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; probe: (item: unknown) => Promise<void> };
    const item = { key: "test", runtime, busy: false, restartPending: false, model: "openai/old", thinking: "low",
      eventSequence: 0, expectedOperationId: "compact-1", lastProgressAt: Date.now() };
    internals.live.set(`${workspaceIdentity(cwd)}\0${sessionId}`, item);
    await internals.probe(item);
    expect(emitted).toContainEqual({ type: "compaction.end", runId: "compact-1", message: "" });
    expect(emitted).toContainEqual({ type: "operation.settled", runId: "compact-1", status: "completed", recovery: true, handledWithoutTurn: true });
  });

  it("leaves an ordinary recovered turn unmarked so a real empty reply still reports", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-recovered-turn-test"));
    const sessionId = "recovered-turn-session";
    const emitted: Array<Record<string, unknown>> = [];
    const sendCommand = vi.fn().mockResolvedValue({ success: true, data: { busy: false, eventSequence: 0,
      lastResult: { operationId: "prompt-1", kind: "prompt", status: "completed" } } });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand,
      emit: (_name: string, value: Record<string, unknown>) => { emitted.push(value); } };
    const service = new AgentCoreSessionService({} as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; probe: (item: unknown) => Promise<void> };
    const item = { key: "test", runtime, busy: false, restartPending: false, model: "openai/old", thinking: "low",
      eventSequence: 0, expectedOperationId: "prompt-1", lastProgressAt: Date.now() };
    internals.live.set(`${workspaceIdentity(cwd)}\0${sessionId}`, item);
    await internals.probe(item);
    expect(emitted).toEqual([{ type: "operation.settled", runId: "prompt-1", status: "completed", recovery: true }]);
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
          runtime.emit("event", { type: "operation.started", runId: "recovery", turnId: "recovery" });
          runtime.emit("event", { type: "operation.settled", runId: "recovery" });
          return { success: true };
        } });
      const hub = { bind: (_cwd: string, source: EventEmitter, callbacks: { onBusy(busy: boolean): void }) => {
        source.on("event", (event: { type: string }) => {
          if (event.type === "operation.started") callbacks.onBusy(true);
          if (event.type === "operation.settled") callbacks.onBusy(false);
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

describe("agent-core operation progress watchdog", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  async function supervised() {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.stubEnv("PI_SCIENCE_EVENT_WATCHDOG_MS", "100");
    vi.stubEnv("PI_SCIENCE_OPERATION_NO_PROGRESS_MS", "1000");
    const snapshot = { busy: true, operation: { id: "run" }, eventSequence: 0, faulted: false, pendingInteraction: false };
    const runtime = Object.assign(new EventEmitter(), { cwd: process.cwd(), sessionId: "watchdog", isClosed: false,
      sendCommand: vi.fn(async () => ({ success: true, data: snapshot })) });
    const service = new AgentCoreSessionService({ bind: () => undefined } as never, {} as never);
    const internals = service as unknown as {
      attach(key: string, runtime: unknown, model: string, thinking: string, config: unknown): Promise<{ lastProgressAt: number }>;
      probe(item: unknown): Promise<void>; recover(item: unknown): Promise<void>;
    };
    const recover = vi.spyOn(internals, "recover").mockResolvedValue();
    const live = await internals.attach("watchdog", runtime, "openai/gpt-4.1-mini", "off", {});
    return { runtime, snapshot, recover, live, internals };
  }

  it("does not count successful liveness probes as operation progress", async () => {
    const { runtime, recover, live } = await supervised();
    await vi.advanceTimersByTimeAsync(900);
    expect(runtime.sendCommand.mock.calls.length).toBeGreaterThan(5);
    expect(live.lastProgressAt).toBe(100_000);
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(recover).toHaveBeenCalledOnce();
  });

  it("extends the deadline only for progress from the current operation", async () => {
    const { runtime, recover, live } = await supervised();
    await vi.advanceTimersByTimeAsync(600);
    runtime.emit("event", { type: "message.updated", runId: "run" });
    expect(live.lastProgressAt).toBe(100_600);
    await vi.advanceTimersByTimeAsync(600);
    runtime.emit("event", { type: "message.updated", runId: "other-run" });
    runtime.emit("event", { type: "session.stats" });
    runtime.emit("event", { type: "operation.started", runId: "run" });
    expect(live.lastProgressAt).toBe(100_600);
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(recover).toHaveBeenCalledOnce();
  });

  it("excludes user interaction waiting and resumes supervision after the response", async () => {
    const { runtime, snapshot, recover, live, internals } = await supervised();
    snapshot.pendingInteraction = true;
    runtime.emit("event", { type: "interaction.requested" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recover).not.toHaveBeenCalled();
    snapshot.pendingInteraction = false;
    await internals.probe(live);
    await vi.advanceTimersByTimeAsync(900);
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(recover).toHaveBeenCalledOnce();
  });

  it("cancels supervision when the operation settles", async () => {
    const { runtime, recover } = await supervised();
    runtime.emit("event", { type: "operation.settled", runId: "run" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recover).not.toHaveBeenCalled();
  });
});
