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
      { key: "test", runtime, busy: true, openedGeneration: 0, model: "openai/old", thinking: "low" });
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
      { key: "test", runtime, busy: false, openedGeneration: 0, model: "openai/old", thinking: "low" });
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

  it("brings a worker onto the reloaded model before the turn starts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-intent-before-turn-"));
    await mkdir(workspaceFile(cwd, "turn-lifecycle"), { recursive: true });
    const sessionId = "intent-before-turn";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const sendCommand = vi.fn().mockImplementation(async (type: string, params: Record<string, unknown>) => type === "configure"
      ? { success: true, data: { model: { provider: params.provider, modelId: params.modelId }, thinkingLevel: params.level } }
      : { success: true, data: {} });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; reloadGeneration: number };
    await service.reloadConfiguration({ model: "openai/new", thinking: "high" });
    // The worker is current for resources and only its model is behind the intent, which
    // is the case a model change produces: it needs configuring, not a fresh process.
    internals.live.set(key, { key, runtime, busy: false, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, eventSequence: 0, openedGeneration: internals.reloadGeneration, lastProgressAt: 0 });

    expect(await service.command(cwd, sessionId, "prompt", { message: "hello" }, { skills: [], extensions: [] }))
      .toMatchObject({ success: true });

    // The reload publishes intent; the turn applies it before dispatching, and applies
    // the model and the level together.
    expect(sendCommand).toHaveBeenCalledWith("configure", expect.objectContaining({ provider: "openai", modelId: "new", level: "high" }));
    expect(sendCommand).toHaveBeenLastCalledWith("prompt", expect.anything());
    await rm(cwd, { recursive: true, force: true });
  });

  it("fails the turn when the intent changes while the prompt is being prepared", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-intent-during-prepare-"));
    await mkdir(workspaceFile(cwd, "turn-lifecycle"), { recursive: true });
    const sessionId = "intent-during-prepare";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const sendCommand = vi.fn().mockResolvedValue({ success: true, data: {} });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; turns: unknown };
    internals.live.set(key, { key, runtime, busy: false, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, eventSequence: 0, openedGeneration: 0, lastProgressAt: 0 });
    // A settings save lands while preparation is awaiting, which is after the worker was
    // already brought current and before the turn is dispatched.
    internals.turns = {
      // A settings save publishes its intent without waiting for this session's turn.
      prepare: async () => { void service.reloadConfiguration({ model: "openai/other", thinking: "high" }).catch(() => undefined); },
      discardRejected: async () => undefined,
    };

    const result = await service.command(cwd, sessionId, "prompt", { message: "hello" }, { skills: [], extensions: [] });

    expect(result).toMatchObject({ success: false, code: "configuration_reload_failed" });
    expect(sendCommand).not.toHaveBeenCalledWith("prompt", expect.anything());
    await rm(cwd, { recursive: true, force: true });
  });

  it("does not stop a worker that is running a turn", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-busy-reload-test"));
    const sessionId = "busy-reload-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const sendCommand = vi.fn().mockResolvedValue({ success: true, data: {} });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; manager: { stop: (key: string) => Promise<void> } };
    const item = { key, runtime, busy: true, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, eventSequence: 0, openedGeneration: 0, lastProgressAt: 0 };
    internals.live.set(key, item);
    const stopped: string[] = [];
    internals.manager = { stop: async (stoppedKey: string) => { stopped.push(stoppedKey); } };

    // The turn has to finish first, so a resource reload must not stop it.
    await service.reloadConfiguration();

    expect(stopped).toEqual([]);
    expect(internals.live.get(key)).toBe(item);
  });

  it("does not retire a worker that admitted an operation but has not reported busy yet", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-admitted-reload-test"));
    const sessionId = "admitted-reload-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    // The worker reports an operation in flight while the record still looks idle: the busy
    // event is emitted at the first model turn, which is after the command that durably
    // admitted the operation, so the record cannot be trusted on its own.
    const sendCommand = vi.fn().mockResolvedValue({ success: true, data: { busy: true } });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; manager: { stop: (key: string) => Promise<void> } };
    const item = { key, runtime, busy: false, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, eventSequence: 0, openedGeneration: 0, lastProgressAt: 0 };
    internals.live.set(key, item);
    const stopped: string[] = [];
    internals.manager = { stop: async (stoppedKey: string) => { stopped.push(stoppedKey); } };

    await service.reloadConfiguration();

    expect(stopped).toEqual([]);
    expect(internals.live.get(key)).toBe(item);
  });

  it("retries a recovery whose replacement failed to start", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-recovery-retry-test"));
    const sessionId = "recovery-retry-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    vi.useFakeTimers();
    try {
      const runtime = { cwd, sessionId, isClosed: false, sendCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
        child: { kill: () => undefined } };
      const service = new AgentCoreSessionService({ expectExit: () => undefined, publish: async () => undefined } as never, {} as never);
      const internals = service as unknown as { live: Map<string, unknown>; manager: { stop: (key: string) => Promise<void> };
        open: (...args: unknown[]) => Promise<unknown>; recover: (item: unknown) => Promise<void> };
      const item = { key, runtime, busy: false, model: "openai/old", thinking: "low",
        config: { skills: [], extensions: [] }, eventSequence: 0, openedGeneration: 0, lastProgressAt: 0 };
      internals.live.set(key, item);
      internals.manager = { stop: async () => undefined };
      let attempts = 0;
      internals.open = async () => { attempts += 1; return { success: false, code: "spawn_failed", error: "no capacity" }; };

      await internals.recover(item);
      // The first failure is reported as recoverable, so the scheduled retry has to run: it is
      // the only thing that can bring a replacement back after a transient start failure.
      await vi.advanceTimersByTimeAsync(300);

      expect(attempts).toBeGreaterThan(1);
    } finally { vi.useRealTimers(); }
  });

  it("replaces a worker that only has queued work", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-queued-reload-test"));
    const sessionId = "queued-reload-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    // The worker reports queued inbox items and no running operation. Those items are durable,
    // so a replacement lane restores them and the next turn delivers them; holding the worker
    // back for them would leave every later command rejected as stale with nothing to drain it.
    const sendCommand = vi.fn().mockResolvedValue({ success: true, data: { busy: false, queues: ["queued"] } });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; manager: { stop: (key: string) => Promise<void> } };
    internals.live.set(key, { key, runtime, busy: false, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, eventSequence: 0, openedGeneration: 0, lastProgressAt: 0 });
    const stopped: string[] = [];
    internals.manager = { stop: async (stoppedKey: string) => { stopped.push(stoppedKey); } };

    await service.reloadConfiguration();

    expect(stopped).toEqual([key]);
  });

  it("stops a worker whose configure reply was lost", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-lost-reply-test"));
    const sessionId = "lost-reply-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const sendCommand = vi.fn().mockRejectedValue(new AgentRuntimeTimeoutError("configure", 30_000));
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; manager: { stop: (key: string) => Promise<void> } };
    internals.live.set(key, { key, runtime, busy: false, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, eventSequence: 0, openedGeneration: 0, lastProgressAt: 0 });
    const stopped: string[] = [];
    internals.manager = { stop: async (stoppedKey: string) => { stopped.push(stoppedKey); } };

    // The worker writes the change before it answers, so a lost reply leaves its state
    // unknown. It must not keep running on a configuration nothing recorded.
    expect(await service.configure(cwd, sessionId, "openai/new", "high", { skills: [], extensions: [] }))
      .toMatchObject({ success: false });
    expect(stopped).toEqual([key]);
  });

  it("replaces an idle worker that a resource reload outdates", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-idle-reload-test"));
    const sessionId = "idle-reload-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const sendCommand = vi.fn().mockResolvedValue({ success: true, data: {} });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; manager: { stop: (key: string) => Promise<void> } };
    const item = { key, runtime, busy: false, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, eventSequence: 0, openedGeneration: 0, lastProgressAt: 0 };
    internals.live.set(key, item);
    const stopped: string[] = [];
    internals.manager = { stop: async (stoppedKey: string) => { stopped.push(stoppedKey); } };

    // Only a fresh process picks up changed resources, so an idle worker is replaced.
    await service.reloadConfiguration();

    expect(stopped).toEqual([key]);
    expect(internals.live.has(key)).toBe(false);
  });

  it("reports the model a session without a worker would start on", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-intent-state-test"));
    const sessionId = "intent-state-session";
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { repository: unknown; registry: unknown };
    internals.repository = {
      findPath: async () => join(cwd, "session.jsonl"),
      configuration: async () => ({ model: { provider: "openai", modelId: "old" }, thinkingLevel: "low" }),
      runtimeState: async () => ({}),
    };
    internals.registry = { get: async () => ({ state: "active" }) };

    // The intent outlives the worker that was retired, so a cold session reports it.
    await service.reloadConfiguration({ model: "openai/new", thinking: "high" });

    expect(await service.state(cwd, sessionId, { skills: [], extensions: [] }))
      .toMatchObject({ model: "openai/new", thinking: "high" });
  });

  it("keeps a global change that lands while a direct configure is waiting", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-order-test"));
    const sessionId = "order-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { newestIntent: (key: string) => unknown;
      configureOnce: (cwd: string, sessionId: string, model: string) => Promise<unknown> };
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    internals.configureOnce = async (_cwd: string, _sessionId: string, model: string) => {
      await gate;
      return { success: true, sessionId, model, thinking: "high", restarted: false };
    };

    // The user's choice is requested first, so it holds the lower revision; the settings
    // change is requested while it waits, so the settings change is newer and must win.
    const direct = service.configure(cwd, sessionId, "openai/chosen", "high", { skills: [], extensions: [] });
    const reload = service.reloadConfiguration({ model: "openai/global", thinking: "high" });
    release();
    await direct;
    await reload;

    // The settings change was requested later, so it outranks the choice that finished
    // afterwards, and the next turn resolves to it.
    expect(internals.newestIntent(key)).toMatchObject({ model: "openai/global" });
  });

  it("dispatches a turn after a model change that omitted the thinking level", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-level-omitted-"));
    await mkdir(workspaceFile(cwd, "turn-lifecycle"), { recursive: true });
    const sessionId = "level-omitted";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const sendCommand = vi.fn().mockImplementation(async (type: string, params: Record<string, unknown>) => type === "configure"
      // The worker keeps its current level when none is requested, and reports it back.
      ? { success: true, data: { model: { provider: params.provider, modelId: params.modelId }, thinkingLevel: "high" } }
      : { success: true, data: {} });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; reloadGeneration: number;
      newestIntent: (key: string) => unknown };
    await service.reloadConfiguration();
    internals.live.set(key, { key, runtime, busy: false, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, eventSequence: 0, openedGeneration: internals.reloadGeneration, lastProgressAt: 0 });

    // The model route allows the level to be omitted, so the intent must record the level
    // the worker actually holds rather than the omission.
    expect(await service.configure(cwd, sessionId, "openai/new", undefined, { skills: [], extensions: [] }))
      .toMatchObject({ success: true });
    expect(internals.newestIntent(key)).toMatchObject({ model: "openai/new", thinking: "high" });
    expect(await service.command(cwd, sessionId, "prompt", { message: "hello" }, { skills: [], extensions: [] }))
      .toMatchObject({ success: true });
    expect(sendCommand).toHaveBeenLastCalledWith("prompt", expect.anything());
    await rm(cwd, { recursive: true, force: true });
  });

  it("does not start a follow-up or a compaction on a worker a resource reload outdates", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-resource-gate-test"));
    const sessionId = "resource-gate-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const sendCommand = vi.fn().mockResolvedValue({ success: true, data: {} });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown> };
    internals.live.set(key, { key, runtime, busy: true, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, eventSequence: 0, openedGeneration: 0, lastProgressAt: 0 });

    // A resource-only reload records no model intent, so only the generation marks this
    // worker as out of date, and the running turn itself is left alone.
    await service.reloadConfiguration();

    for (const type of ["follow_up", "compact"]) {
      expect(await service.command(cwd, sessionId, type, { message: "more" }, { skills: [], extensions: [] }))
        .toMatchObject({ success: false, code: "configuration_reload_failed" });
      expect(sendCommand).not.toHaveBeenCalledWith(type, expect.anything());
    }
  });

  it("keeps a model chosen for one session over an older global change", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-session-wins-test"));
    const sessionId = "session-wins";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { newestIntent: (key: string) => unknown;
      configureOnce: (cwd: string, sessionId: string, model: string) => Promise<unknown> };
    internals.configureOnce = async (_cwd: string, _sessionId: string, model: string) =>
      ({ success: true, sessionId, model, thinking: "high", restarted: false });

    await service.reloadConfiguration({ model: "openai/global", thinking: "high" });
    await service.configure(cwd, sessionId, "openai/chosen", "high", { skills: [], extensions: [] });

    // The per-session choice is newer, so it is what that session resolves to, while the
    // settings choice still stands for every other session.
    expect(internals.newestIntent(key)).toMatchObject({ model: "openai/chosen" });
    expect(internals.newestIntent("other-session")).toMatchObject({ model: "openai/global" });
  });

  it("holds a follow-up back when the worker is running on a replaced model", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-followup-test"));
    const sessionId = "followup-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const sendCommand = vi.fn().mockResolvedValue({ success: true, data: {} });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown> };
    internals.live.set(key, { key, runtime, busy: true, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, eventSequence: 0, openedGeneration: 0, lastProgressAt: 0 });
    await service.reloadConfiguration({ model: "openai/new", thinking: "high" });

    // A follow-up queues a new turn, so it must not be added to a worker that is still on
    // the replaced model. The running turn itself is left alone.
    expect(await service.command(cwd, sessionId, "follow_up", { message: "more" }, { skills: [], extensions: [] }))
      .toMatchObject({ success: false, code: "configuration_reload_failed" });
    expect(sendCommand).not.toHaveBeenCalledWith("follow_up", expect.anything());
  });

  it("waits for a command that holds the session mutation before replacing its worker", async () => {
    const cwd = resolve(join(tmpdir(), "pi-science-core-mutation-order-test"));
    const sessionId = "mutation-order-session";
    const key = `${workspaceIdentity(cwd)}\0${sessionId}`;
    const sendCommand = vi.fn().mockResolvedValue({ success: true, data: {} });
    const runtime = { cwd, sessionId, isClosed: false, sendCommand };
    const service = new AgentCoreSessionService({ expectExit: () => undefined } as never, {} as never);
    const internals = service as unknown as { live: Map<string, unknown>; manager: { stop: (key: string) => Promise<void> };
      withMutation: (cwd: string, sessionId: string, operation: () => Promise<unknown>) => Promise<unknown> };
    internals.live.set(key, { key, runtime, busy: false, model: "openai/old", thinking: "low",
      config: { skills: [], extensions: [] }, eventSequence: 0, openedGeneration: 0, lastProgressAt: 0 });
    const stopped: string[] = [];
    internals.manager = { stop: async (stoppedKey: string) => { stopped.push(stoppedKey); } };
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const held = internals.withMutation(cwd, sessionId, () => gate);

    const reload = service.reloadConfiguration();
    await Promise.resolve();
    // The command that holds the mutation must not have its worker stopped underneath it.
    expect(stopped).toEqual([]);
    release();
    await held;
    await reload;

    expect(stopped).toEqual([key]);
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
    const item = { key: "test", runtime, busy: false, openedGeneration: 0, model: "openai/old", thinking: "low",
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
    const item = { key: "test", runtime, busy: false, openedGeneration: 0, model: "openai/old", thinking: "low",
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
      { key: "test", runtime, busy: false, openedGeneration: 0, model: "openai/old", thinking: "low" });
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
      const live = { key: "test", runtime, busy: false, openedGeneration: 0, model: "openai/old", thinking: "low" };
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
      const live = { key: "test", runtime, busy: false, openedGeneration: 0, model: "openai/old", thinking: "low" };
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
        { key: "test", runtime, busy: false, openedGeneration: 0, model: "openai/old", thinking: "low" });
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
      const hub = { expectExit: () => undefined, publish: async () => undefined,
        bind: (_cwd: string, source: EventEmitter, callbacks: { onBusy(busy: boolean): void }) => {
          source.on("event", (event: { type: string }) => {
            if (event.type === "operation.started") callbacks.onBusy(true);
            if (event.type === "operation.settled") callbacks.onBusy(false);
          });
        } };
      const service = new AgentCoreSessionService(hub as never, {} as never);
      const live = await (service as unknown as {
        attach(key: string, runtime: unknown, model: string, level: string, config: unknown, generation: number): Promise<{ busy: boolean }> })
        .attach("test", runtime, "openai/old", "low", {}, 0);
      expect(live.busy).toBe(false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("waits for activation before aborting a partially attached recovery", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-opening-"));
    try {
      const sessionId = "opening-recovery";
      const runtime = { cwd, sessionId, isClosed: false, sendCommand: vi.fn().mockResolvedValue({ success: true }) };
      const live = { key: "test", runtime, busy: true, openedGeneration: 0, model: "openai/old", thinking: "low" };
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
