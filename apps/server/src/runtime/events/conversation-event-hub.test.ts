import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationEventHub } from "./conversation-event-hub.js";
import { DurableEventStore, type SseEventRecord } from "./event-store.js";
type RuntimeEventSource = EventEmitter;

const workspaces: string[] = [];

it("flush waits for durable observer work before shutdown completes", async () => {
  const cwd = await workspace();
  const hub = new ConversationEventHub({ append: async () => undefined, readAfter: async () => [] });
  const runtime = new EventEmitter();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const persistence = new Promise<void>((resolve) => { release = resolve; });
  hub.bind(cwd, runtime as RuntimeEventSource, { activeSessionId: () => "shutdown-session", onBusy: () => undefined, onExit: () => undefined,
    observe: async () => { entered(); await persistence; } });
  runtime.emit("event", { type: "operation.settled", status: "completed" });
  await started;
  let completed = false;
  const flushed = hub.flush().then(() => { completed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(completed).toBe(false);
  release();
  await flushed;
  expect(completed).toBe(true);
});

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function workspace(): Promise<string> {
  const path = join(tmpdir(), `pi-science-event-hub-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  workspaces.push(path);
  await mkdir(join(path, ".pi-science"), { recursive: true });
  return path;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}

describe("central conversation event hub", () => {
  it("passes the published identity to observers across empty turns and hub restarts", async () => {
    const cwd = await workspace();
    const records: SseEventRecord[] = [];
    const store = {
      append: async (_cwd: string, _sessionId: string, event: SseEventRecord) => { records.push(event); },
      readAfter: async () => records,
    };
    const observed: Array<{ type: string; turnId: string; turnOrdinal: number }> = [];
    const run = async (count: number) => {
      const hub = new ConversationEventHub(store);
      const process = new EventEmitter();
      hub.bind(cwd, process as RuntimeEventSource, {
        activeSessionId: () => "identity-test",
        onBusy: () => {}, onExit: () => {},
        observe: (event, _sessionId, identity) => {
          if (identity) observed.push({ type: event.type, ...identity });
        },
      });
      const before = observed.length;
      for (let i = 0; i < count; i += 1) {
        process.emit("event", { type: "operation.started" });
        process.emit("event", { type: "operation.settled", status: "completed" });
      }
      await eventually(() => observed.length === before + count * 2);
    };
    await run(3);
    await run(1);
    const starts = observed.filter((item) => item.type === "operation.started");
    expect(starts.map((item) => item.turnOrdinal)).toEqual([1, 2, 3, 1]);
    expect(new Set(starts.map((item) => item.turnId)).size).toBe(4);
    const published = records.map((record) => JSON.parse(record.data));
    for (const item of observed) {
      expect(published).toContainEqual(expect.objectContaining({
        type: item.type === "operation.started" ? "operation.started" : "operation.settled",
        turnId: item.turnId, turnOrdinal: item.turnOrdinal,
      }));
    }
  });

  it("deduplicates an event that appears in both replay and the live replay window", async () => {
    const cwd = await workspace();
    const records: SseEventRecord[] = [];
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseRead = resolve; });
    const store = {
      append: async (_cwd: string, _sessionId: string, event: SseEventRecord) => { records.push(event); },
      readAfter: async () => {
        readStarted();
        await release;
        return [...records];
      },
    };
    const hub = new ConversationEventHub(store, { createStreamEpoch: () => "epoch-window" });
    const received: SseEventRecord[] = [];
    const subscribing = hub.subscribe(cwd, "session-race", undefined, (event) => received.push(event));
    await started;
    await hub.publish(cwd, "session-race", { type: "message.delta", sessionId: "session-race", text: "once" });
    releaseRead();
    await subscribing;

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.data).text).toBe("once");
  });

  it("can subscribe live without replaying the durable snapshot", async () => {
    const cwd = await workspace();
    let readCalled = false;
    const store = {
      append: async () => undefined,
      readAfter: async () => { readCalled = true; return []; },
    };
    const hub = new ConversationEventHub(store);
    const received: SseEventRecord[] = [];
    const unsubscribe = await hub.subscribe(cwd, "session-live", undefined, (record) => received.push(record), false);
    expect(hub.hasSubscribers(cwd, "session-live")).toBe(true);
    await hub.publish(cwd, "session-live", { type: "operation.settled", status: "completed", sessionId: "session-live" });

    expect(readCalled).toBe(false);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.data)).toMatchObject({ type: "operation.settled", status: "completed", sessionId: "session-live" });
    unsubscribe();
    expect(hub.hasSubscribers(cwd, "session-live")).toBe(false);
  });

  it("writes an identity-bearing v3 product envelope", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub(
      { append: async () => undefined, readAfter: async () => [] },
      { createStreamEpoch: () => "epoch-test" },
    );
    const received: SseEventRecord[] = [];
    await hub.subscribe(cwd, "session-v2", undefined, (record) => received.push(record), false);

    await hub.publish(cwd, "session-v2", {
      type: "message.delta",
      sessionId: "session-v2",
      turnId: "turn-1",
      runId: "run-1",
      streamEpoch: "epoch-1",
      partId: "answer-1",
      text: "answer",
    });

    const event = JSON.parse(received[0]!.data) as Record<string, unknown>;
    expect(event).toMatchObject({
      schemaVersion: 3,
      workspaceId: cwd,
      sessionId: "session-v2",
      streamEpoch: "epoch-test",
      eventId: "epoch-test:1",
      seq: 1,
      turnId: "turn-1",
      runId: "run-1",
      type: "message.delta",
      text: "answer",
      payload: expect.objectContaining({ type: "message.delta", partId: "answer-1", text: "answer" }),
    });
    expect(typeof event.occurredAt).toBe("string");
  });

  it("gives a record without turn identity its stream position too", async () => {
    // Session stats carry no turn/run identity but still consume a stream
    // position. A consumer that cannot see the position reads every one of them
    // as a hole and rebases the conversation for a healthy stream.
    const cwd = await workspace();
    const hub = new ConversationEventHub(
      { append: async () => undefined, readAfter: async () => [] },
      { createStreamEpoch: () => "epoch-stats" },
    );
    const received: SseEventRecord[] = [];
    await hub.subscribe(cwd, "session-stats", undefined, (record) => received.push(record), false);

    await hub.publish(cwd, "session-stats", { type: "session.stats", sessionId: "session-stats", stats: { turns: 1 } });

    const event = JSON.parse(received[0]!.data) as Record<string, unknown>;
    expect(event).toMatchObject({
      schemaVersion: 3,
      sessionId: "session-stats",
      streamEpoch: "epoch-stats",
      eventId: "epoch-stats:1",
      seq: 1,
      type: "session.stats",
      stats: { turns: 1 },
    });
    expect(event.turnId).toBeUndefined();
    expect(received[0]!.id).toBe("epoch-stats:1");
  });

  it("chunks large UTF-8 text records before the durable record limit", async () => {
    const cwd = await workspace();
    const records: SseEventRecord[] = [];
    const hub = new ConversationEventHub({
      append: async (_cwd, _sessionId, record) => { records.push(record); },
      readAfter: async () => [],
    }, { createStreamEpoch: () => "epoch-text" });
    const text = "科研".repeat(40_000);

    await hub.publish(cwd, "session-large-text", {
      type: "message.delta",
      sessionId: "session-large-text",
      turnId: "turn-large",
      runId: "run-large",
      partId: "part-large",
      revision: 1,
      baseRevision: 0,
      text,
    });

    expect(records.length).toBeGreaterThan(1);
    expect(records.every((record) => Buffer.byteLength(JSON.stringify(record), "utf8") <= 256 * 1024)).toBe(true);
    expect(records.map((record) => (JSON.parse(record.data) as Record<string, unknown>).text).join(""))
      .toBe(text);
    expect(records.map((record) => record.id)).toEqual(records.map((_record, index) => `epoch-text:${index + 1}`));
  });

  it("rotates the stream epoch after an append failure while preserving live delivery", async () => {
    const cwd = await workspace();
    const persisted: SseEventRecord[] = [];
    let fail = true;
    const epochs = ["epoch-failed", "epoch-recovered"];
    const hub = new ConversationEventHub({
      append: async (_cwd, _sessionId, record) => {
        if (fail) {
          fail = false;
          throw new Error("disk unavailable");
        }
        persisted.push(record);
      },
      readAfter: async () => persisted,
    }, { createStreamEpoch: () => epochs.shift() ?? "epoch-fallback" });
    const received: SseEventRecord[] = [];
    await hub.subscribe(cwd, "session-persistence", undefined, (record) => received.push(record), false);

    await hub.publish(cwd, "session-persistence", { type: "status.updated", sessionId: "session-persistence", status: "live-only" });
    await hub.publish(cwd, "session-persistence", { type: "status.updated", sessionId: "session-persistence", status: "recovered" });

    expect(received.map((record) => record.id)).toEqual(["epoch-failed:1", "epoch-recovered:1"]);
    expect(persisted.map((record) => record.id)).toEqual(["epoch-recovered:1"]);
  });

  it("never persists a later text chunk in a tainted epoch", async () => {
    const cwd = await workspace();
    const persisted: SseEventRecord[] = [];
    let fail = true;
    const epochs = ["epoch-chunk-failed", "epoch-chunk-recovered"];
    const hub = new ConversationEventHub({
      append: async (_cwd, _sessionId, record) => {
        if (fail) {
          fail = false;
          throw new Error("disk unavailable");
        }
        persisted.push(record);
      },
      readAfter: async () => persisted,
    }, { createStreamEpoch: () => epochs.shift() ?? "epoch-chunk-fallback" });

    await hub.publish(cwd, "session-chunk-failure", {
      type: "message.delta",
      sessionId: "session-chunk-failure",
      turnId: "turn-chunk",
      runId: "run-chunk",
      partId: "part-chunk",
      revision: 1,
      baseRevision: 0,
      text: "大文本".repeat(40_000),
    });
    await hub.publish(cwd, "session-chunk-failure", { type: "status.updated", sessionId: "session-chunk-failure", status: "next" });

    expect(persisted.map((record) => record.id)).toEqual(["epoch-chunk-recovered:1"]);
    expect(persisted.every((record) => !record.id?.startsWith("epoch-chunk-failed:"))).toBe(true);
  });

  it("does not append or deliver a guarded publication that is invalid before publishing", async () => {
    const cwd = await workspace();
    let allowed = false;
    const appended: SseEventRecord[] = [];
    const store = {
      append: async (_cwd: string, _sessionId: string, record: SseEventRecord) => { appended.push(record); },
      readAfter: async () => [],
    };
    const hub = new ConversationEventHub(store, { createStreamEpoch: () => "epoch-window" });
    const received: SseEventRecord[] = [];
    await hub.subscribe(cwd, "session-guarded", undefined, (record) => received.push(record), false);

    await hub.publish(cwd, "session-guarded", { type: "operation.settled", status: "completed", sessionId: "session-guarded" }, () => allowed);

    expect(appended).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  it("does not append or deliver a guarded publication invalidated during the append window", async () => {
    const cwd = await workspace();
    let allowed = true;
    let releaseAppend!: () => void;
    let appendStarted!: () => void;
    const appendReady = new Promise<void>((resolve) => { appendStarted = resolve; });
    const appendRelease = new Promise<void>((resolve) => { releaseAppend = resolve; });
    const appended: SseEventRecord[] = [];
    const store = {
      append: async () => { throw new Error("conditional append was not used"); },
      appendConditional: async (_cwd: string, _sessionId: string, record: SseEventRecord, guard: () => boolean) => {
        appendStarted();
        await appendRelease;
        if (!guard()) return false;
        appended.push(record);
        return true;
      },
      readAfter: async () => [],
    };
    const hub = new ConversationEventHub(store, { createStreamEpoch: () => "epoch-window" });
    const received: SseEventRecord[] = [];
    await hub.subscribe(cwd, "session-window", undefined, (record) => received.push(record), false);

    const publishing = hub.publish(cwd, "session-window", { type: "operation.settled", status: "completed", sessionId: "session-window" }, () => allowed);
    await appendReady;
    allowed = false;
    releaseAppend();
    await publishing;

    expect(appended).toHaveLength(0);
    expect(received).toHaveLength(0);

    await hub.publish(cwd, "session-window", { type: "operation.started", sessionId: "session-window" });
    expect(received.map((record) => JSON.parse(record.data).type)).toEqual(["operation.started"]);
    expect(received[0]?.id).toBe("epoch-window:1");
  });

  it("re-delivers pending interactions to a fresh subscriber without a cursor", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub({
      append: async () => undefined,
      readAfter: async () => [],
    });
    await hub.publish(cwd, "session-pending", { type: "questionnaire.asked", sessionId: "session-pending", toolCallId: "call-q1", questions: [] });
    await hub.publish(cwd, "session-pending", { type: "interaction.requested", sessionId: "session-pending", requestId: "request-q1", questionnaire: true, toolCallId: "call-q1" });

    const received: string[] = [];
    await hub.subscribe(cwd, "session-pending", undefined, (record) => {
      received.push(JSON.parse(record.data).type as string);
    }, false);

    expect(received).toEqual(["questionnaire.asked", "interaction.requested"]);
  });

  it("keeps only the latest generic interaction for refresh recovery", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub({ append: async () => undefined, readAfter: async () => [] });
    await hub.publish(cwd, "session-generic", { type: "interaction.requested", sessionId: "session-generic", requestId: "request-1" });
    await hub.publish(cwd, "session-generic", { type: "interaction.requested", sessionId: "session-generic", requestId: "request-2" });

    const received: Record<string, unknown>[] = [];
    await hub.subscribe(cwd, "session-generic", undefined, (record) => {
      received.push(JSON.parse(record.data));
    }, false);

    expect(received).toEqual([expect.objectContaining({ type: "interaction.requested", requestId: "request-2" })]);
  });

  it("removes the questionnaire pair when its interaction is resolved", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub({ append: async () => undefined, readAfter: async () => [] });
    await hub.publish(cwd, "session-resolved", { type: "questionnaire.asked", sessionId: "session-resolved", toolCallId: "call-q1", questions: [] });
    await hub.publish(cwd, "session-resolved", { type: "interaction.requested", sessionId: "session-resolved", requestId: "request-q1", questionnaire: true, toolCallId: "call-q1" });
    hub.resolvePendingInteraction(cwd, "session-resolved", "request-q1");

    const received: SseEventRecord[] = [];
    await hub.subscribe(cwd, "session-resolved", undefined, (record) => received.push(record), false);

    expect(received).toHaveLength(0);
  });

  it("does not re-deliver an interaction after it has been resolved", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub({
      append: async () => undefined,
      readAfter: async () => [],
    });
    await hub.publish(cwd, "session-resolved", { type: "interaction.requested", sessionId: "session-resolved", requestId: "request-q1" });
    await hub.publish(cwd, "session-resolved", { type: "questionnaire.finished", sessionId: "session-resolved", toolCallId: "call-q1" });

    const received: SseEventRecord[] = [];
    await hub.subscribe(cwd, "session-resolved", undefined, (record) => received.push(record), false);

    expect(received).toHaveLength(0);
  });

  it("preserves exact message.completed errors and emits one durable event per Pi event", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const first: Array<{ id: string | null; data: Record<string, unknown> }> = [];
    const second: Array<{ id: string | null; data: Record<string, unknown> }> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-1", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-1", undefined, (record) => first.push({ id: record.id, data: JSON.parse(record.data) }));
    await hub.subscribe(cwd, "session-1", undefined, (record) => second.push({ id: record.id, data: JSON.parse(record.data) }));

    process.emit("event", { type: "operation.started" });
    process.emit("event", { type: "message.completed", message: { role: "assistant", stopReason: "error", errorMessage: "OpenAI API error (401): Invalid API key" } });
    process.emit("event", { type: "operation.settled", status: "completed" });
    await eventually(() => first.length === 3 && second.length === 3);

    expect(first.map((item) => item.data.type)).toEqual(["operation.started", "error", "operation.settled"]);
    expect(first[1]?.data.message).toContain("Invalid API key");
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));

    const replay: Array<Record<string, unknown>> = [];
    await hub.subscribe(cwd, "session-1", first[0]?.id ?? undefined, (record) => replay.push(JSON.parse(record.data)));
    expect(replay.map((item) => item.type)).toEqual(["error", "operation.settled"]);
  });

  it("deduplicates final text after deltas and surfaces process exits", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-2", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-2", undefined, (record) => received.push(JSON.parse(record.data)));
    process.emit("event", { type: "operation.started" });
    process.emit("event", { type: "message.updated", message: { id: "m1" }, content: { kind: "text", type: "text_delta", text: "OK", messageId: "m1", contentIndex: "0" } });
    process.emit("event", { type: "message.updated", message: { id: "m1" }, content: { kind: "text", type: "text_end", text: "OK", messageId: "m1", contentIndex: "0" } });
    process.emit("event", { type: "operation.settled", status: "completed" });
    process.emit("stderr", "fatal adapter error");
    process.emit("exit", { code: 1, signal: null });
    await eventually(() => received.some((event) => event.terminal === true));
    expect(received.filter((event) => event.type === "message.delta").map((event) => event.text)).toEqual(["OK"]);
    expect(received.find((event) => event.terminal === true)?.message).toContain("fatal adapter error");
  });

  it("emits only the missing final-text suffix and isolates anonymous messages", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-text", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-text", undefined, (record) => received.push(JSON.parse(record.data)));

    process.emit("event", { type: "operation.started" });
    process.emit("event", { type: "message.updated", message: { id: "m1" }, content: { kind: "text", type: "text_delta", text: "Hel", messageId: "m1", contentIndex: "0" } });
    process.emit("event", { type: "message.updated", message: { id: "m1" }, content: { kind: "text", type: "text_end", text: "Hello", messageId: "m1", contentIndex: "0" } });
    process.emit("event", { type: "message.updated", content: { kind: "text", type: "text_end", text: "First", messageId: "", contentIndex: "0" } });
    process.emit("event", { type: "message.updated", content: { kind: "text", type: "text_end", text: "Second", messageId: "", contentIndex: "0" } });
    process.emit("event", { type: "message.updated", message: { id: "m2" }, content: { kind: "text", type: "text_delta", text: "old", messageId: "m2", contentIndex: "0" } });
    process.emit("event", { type: "message.updated", message: { id: "m2" }, content: { kind: "text", type: "text_end", text: "replacement", messageId: "m2", contentIndex: "0" } });
    process.emit("event", { type: "operation.settled", status: "completed" });
    await eventually(() => received.some((event) => event.type === "operation.settled"));

    const text = received.filter((event) => event.type === "message.delta");
    expect(text).toHaveLength(4);
    expect(text[0]).toMatchObject({ text: "Hello", partId: "m1:0", itemId: "m1" });
    expect(text[1]?.partId).not.toBe(text[2]?.partId);
    expect(text.at(-1)).toMatchObject({ text: "replacement", replace: true, partId: "m2:0", itemId: "m2" });
  });

  it("streams thinking deltas as message.reasoning.delta without touching the text stream", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-thinking", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-thinking", undefined, (record) => received.push(JSON.parse(record.data)));

    process.emit("event", { type: "operation.started" });
    process.emit("event", { type: "message.updated", message: { id: "m1" }, content: { kind: "thinking", type: "thinking_delta", text: "Let me ", messageId: "m1", contentIndex: "0" } });
    process.emit("event", { type: "message.updated", message: { id: "m1" }, content: { kind: "thinking", type: "thinking_delta", text: "think.", messageId: "m1", contentIndex: "0" } });
    process.emit("event", { type: "message.updated", message: { id: "m1" }, content: { kind: "thinking", type: "thinking_end", text: "Let me think.", messageId: "m1", contentIndex: "0" } });
    process.emit("event", { type: "message.updated", message: { id: "m1" }, content: { kind: "text", type: "text_delta", text: "Answer", messageId: "m1", contentIndex: "1" } });
    process.emit("event", { type: "operation.settled", status: "completed" });
    await eventually(() => received.some((event) => event.type === "operation.settled"));

    // The two thinking deltas coalesce into one batched record; the redundant
    // thinking_end emits nothing. Text keeps its own stream and payload.
    const thinking = received.filter((event) => event.type === "message.reasoning.delta");
    expect(thinking.map((event) => event.text)).toEqual(["Let me think."]);
    expect(thinking[0]).toMatchObject({ partId: "m1:0", itemId: "m1" });
    const text = received.filter((event) => event.type === "message.delta");
    expect(text.map((event) => event.text)).toEqual(["Answer"]);
    expect(text[0]).toMatchObject({ partId: "m1:1", itemId: "m1" });
  });

  it("gives independently revised text content parts distinct wire identities", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-parts", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-parts", undefined, (record) => received.push(JSON.parse(record.data)));

    process.emit("event", { type: "operation.started" });
    process.emit("event", { type: "message.updated", message: { id: "m1" }, content: { kind: "text", type: "text_delta", text: "first", messageId: "m1", contentIndex: "0" } });
    process.emit("event", { type: "message.updated", message: { id: "m1" }, content: { kind: "text", type: "text_delta", text: "second", messageId: "m1", contentIndex: "2" } });
    process.emit("event", { type: "operation.settled", status: "completed" });
    await eventually(() => received.some((event) => event.type === "operation.settled"));

    expect(received.filter((event) => event.type === "message.delta")).toEqual([
      expect.objectContaining({ itemId: "m1", partId: "m1:0", baseRevision: 0, revision: 1, text: "first" }),
      expect.objectContaining({ itemId: "m1", partId: "m1:2", baseRevision: 0, revision: 1, text: "second" }),
    ]);
  });

  it("streams Core bash partial results as tool updates", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-bash-tail", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-bash-tail", undefined, (record) => received.push(JSON.parse(record.data)));

    const snapshot = (text: string) => JSON.stringify({ content: text ? [{ type: "text", text }] : [] });
    process.emit("event", { type: "operation.started" });
    process.emit("event", { type: "tool.started", toolCallId: "b1", toolName: "bash", args: { command: "pip install -U scikit-learn" } });
    process.emit("event", { type: "tool.updated", toolCallId: "b1", toolName: "bash", partialResult: snapshot("Collecting scikit-learn\n") });
    await eventually(() => received.some((event) => event.type === "tool.updated" && String(event.partialOutput ?? "").includes("Collecting scikit-learn")));
    // An empty shell inside the throttle window must not clobber the tail.
    process.emit("event", { type: "tool.updated", toolCallId: "b1", toolName: "bash", partialResult: snapshot("") });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The next snapshot beyond the throttle window replaces the tail.
    process.emit("event", { type: "tool.updated", toolCallId: "b1", toolName: "bash", partialResult: snapshot("Downloading wheel\n") });
    await eventually(() => received.some((event) => event.type === "tool.updated" && String(event.partialOutput ?? "").includes("Downloading wheel")));
    process.emit("event", { type: "tool.completed", toolCallId: "b1", toolName: "bash", result: "installed" });
    await eventually(() => received.some((event) => event.type === "tool.completed" && event.status === "done"));
    const tails = received.filter((event) => event.type === "tool.updated" && typeof event.partialOutput === "string" && String(event.partialOutput).length > 0);
    expect(tails.length).toBeGreaterThanOrEqual(2);
    expect(tails.every((event) => event.callId === "b1")).toBe(true);
  });

  it("preview-truncates oversized tool output with byte metadata", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-tool-output", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-tool-output", undefined, (record) => received.push(JSON.parse(record.data)));

    process.emit("event", { type: "tool.completed", toolCallId: "large", toolName: "read", result: "结果".repeat(100_000) });
    await eventually(() => received.some((event) => event.type === "tool.completed" && event.status === "done"));

    const output = received.find((event) => event.type === "tool.completed" && event.status === "done")!;
    expect(output.outputTruncated).toBe(true);
    expect(output.originalOutputBytes).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(String(output.output), "utf8")).toBeLessThanOrEqual(64 * 1024);
  });

  it("uses partial snapshots to discard repeated and overlapping streaming deltas", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-overlap", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-overlap", undefined, (record) => received.push(JSON.parse(record.data)));

    const partial = (value: string) => ({
      role: "assistant",
      content: [{ type: "text", text: value }],
    });
    const emitDelta = (delta: string, snapshot: string) => process.emit("event", {
      type: "message.updated",
      message: { id: "m-overlap" },
      content: { kind: "text", type: "text_delta", text: delta, messageId: "m-overlap", contentIndex: "0", snapshot },
    });

    process.emit("event", { type: "operation.started" });
    emitDelta("生成出版级图表(matplotlib，带单位", "生成出版级图表(matplotlib，带单位");
    // Duplicate delivery: no new text in the authoritative snapshot.
    emitDelta("生成出版级图表(matplotlib，带单位", "生成出版级图表(matplotlib，带单位");
    // Provider chunk overlaps the previous chunk, but the snapshot advances
    // by only the non-overlapping suffix.
    emitDelta("图表(matplotlib，带单位标注、色盲友好配色", "生成出版级图表(matplotlib，带单位标注、色盲友好配色");
    process.emit("event", { type: "operation.settled", status: "completed" });
    await eventually(() => received.some((event) => event.type === "operation.settled"));

    expect(received.filter((event) => event.type === "message.delta").map((event) => event.text).join(""))
      .toBe("生成出版级图表(matplotlib，带单位标注、色盲友好配色");
  });

  it("continues the durable cursor sequence after the hub is recreated", async () => {
    const cwd = await workspace();
    const store = new DurableEventStore();
    const firstHub = new ConversationEventHub(store);
    await firstHub.publish(cwd, "session-restart", { type: "status.updated", sessionId: "session-restart", status: "first" });
    const first = await store.readAfter(cwd, "session-restart");

    const secondHub = new ConversationEventHub(store);
    await secondHub.publish(cwd, "session-restart", { type: "status.updated", sessionId: "session-restart", status: "second" });
    const all = await store.readAfter(cwd, "session-restart");

    expect(first[0]?.id).toMatch(/^[0-9a-f-]+:1$/);
    expect(all.map((record) => record.id)).toEqual([first[0]?.id, expect.stringMatching(/^[0-9a-f-]+:1$/)]);
    expect(all[1]?.id).not.toBe(first[0]?.id);
    const replay = await store.readAfter(cwd, "session-restart", first[0]?.id);
    expect(replay).toHaveLength(1);
    expect(replay[0]?.event).toBe("stream.gap");
    expect(JSON.parse(replay[0]!.data)).toMatchObject({ type: "stream.gap", reason: "epoch_changed" });
  });

  it("does not classify tool, interaction, or artifact-only turns as empty", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-activity", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-activity", undefined, (record) => received.push(JSON.parse(record.data)));

    for (const event of [
      { type: "tool.completed", toolCallId: "t1", toolName: "read", result: "ok" },
      { type: "interaction.requested", method: "confirm", id: "q1", message: "continue?" },
      { type: "tool.completed", toolCallId: "t2", toolName: "write", result: "result.txt" },
    ]) {
      process.emit("event", { type: "operation.started" });
      process.emit("event", event);
      process.emit("event", { type: "operation.settled", status: "completed" });
    }
    await eventually(() => received.filter((event) => event.type === "operation.settled").length === 3);
    expect(received.filter((event) => event.type === "error")).toEqual([]);
  });

  it("keeps generic confirmations out of the permission channel", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-interactions", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-interactions", undefined, (record) => received.push(JSON.parse(record.data)));

    process.emit("event", { type: "operation.started" });
    process.emit("event", {
      type: "interaction.requested",
      id: "confirm-1",
      method: "confirm",
      title: "Continue?",
      message: "Continue with the next step?",
    });
    process.emit("event", {
      type: "interaction.requested",
      id: "permission-1",
      method: "confirm",
      kind: "permission",
      title: "Install scipy",
      operation: "Install scipy 1.17",
      scope: "Project environment",
      effect: "Creates a new revision",
    });
    process.emit("event", {
      type: "interaction.requested",
      id: "select-1",
      method: "select",
      title: "Choose an output",
      options: ["A", "B"],
    });
    process.emit("event", {
      type: "interaction.requested",
      id: "mcp-permission-1",
      method: "select",
      title: "[pi-science:permission] MCP: papers wants to run search",
      options: ["Allow once", "Allow for session", "Deny"],
    });

    await eventually(() => [
      "confirm-1",
      "permission-1",
      "select-1",
      "mcp-permission-1",
    ].every((requestId) => received.some((event) => event.requestId === requestId)));
    expect(received.find((event) => event.requestId === "confirm-1")).toMatchObject({
      type: "interaction.requested",
      kind: "confirmation",
      method: "confirm",
      title: "Continue?",
    });
    expect(received.find((event) => event.requestId === "permission-1")).toMatchObject({
      type: "interaction.requested",
      kind: "permission",
      method: "confirm",
      operation: "Install scipy 1.17",
      scope: "Project environment",
      effect: "Creates a new revision",
    });
    expect(received.find((event) => event.requestId === "select-1")).toMatchObject({
      type: "interaction.requested",
      kind: "question",
      method: "select",
      title: "Choose an output",
      options: ["A", "B"],
    });
    expect(received.find((event) => event.requestId === "mcp-permission-1")).toMatchObject({
      type: "interaction.requested",
      kind: "permission",
      method: "select",
      title: "MCP: papers wants to run search",
      options: ["Allow once", "Allow for session", "Deny"],
    });
  });

  it("caps interaction metadata that the producer omitted to an empty string", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-metadata", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-metadata", undefined, (record) => received.push(JSON.parse(record.data)));

    process.emit("event", { type: "operation.started" });
    // The managed MCP approval producer sends only a title and options. Every
    // other metadata field is absent, and must not reach the UI as the literal
    // two-character text `""` — that value is truthy, so the permission card
    // would render it instead of falling back to the tool title.
    process.emit("event", {
      type: "interaction.requested",
      id: "mcp-permission-2",
      method: "select",
      title: "[pi-science:permission] MCP: papers wants to run search",
      options: ["Allow once", "Allow for session", "Deny"],
    });

    await eventually(() => received.some((event) => event.requestId === "mcp-permission-2"));
    const published = received.find((event) => event.requestId === "mcp-permission-2")!;
    expect(published).toMatchObject({
      type: "interaction.requested",
      kind: "permission",
      title: "MCP: papers wants to run search",
      operation: "",
      scope: "",
      effect: "",
      message: "",
    });
    // Guard the regression directly: a truthy `""` would win over the title.
    expect(published.operation || published.title).toBe("MCP: papers wants to run search");
  });

  it("publishes activity titles and preserves tool result details", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-presentation", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-presentation", undefined, (record) => received.push(JSON.parse(record.data)));

    process.emit("event", { type: "tool.started", toolCallId: "read-1", toolName: "read", args: { path: "frontend/src/ConversationBlocks.tsx" } });
    process.emit("event", { type: "tool.completed", toolCallId: "read-1", toolName: "read", result: "done", details: { source: "workspace" } });
    await eventually(() => received.filter((event) => event.type === "tool.started" || event.type === "tool.completed").length === 2);

    expect(received.find((event) => event.type === "tool.started" && event.status === "running")).toMatchObject({ title: "Reading ConversationBlocks.tsx" });
    expect(received.find((event) => event.type === "tool.completed" && event.status === "done")).toMatchObject({ details: { source: "workspace" } });
  });

  it("does not generate an activity title for todo", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-todo-title", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-todo-title", undefined, (record) => received.push(JSON.parse(record.data)));

    process.emit("event", { type: "tool.started", toolCallId: "todo-1", toolName: "todo", args: { action: "update" } });
    await eventually(() => received.some((event) => event.type === "tool.started"));
    expect(received.find((event) => event.type === "tool.started")).not.toHaveProperty("title");
  });

  it("publishes a structured questionnaire and marks its browser response request", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-questionnaire", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-questionnaire", undefined, (record) => received.push(JSON.parse(record.data)));

    process.emit("event", { type: "operation.started" });
    process.emit("event", {
      type: "tool.started",
      toolCallId: "call-q1",
      toolName: "ask_user_question",
      args: {
        questions: [{
          question: "Which mode?",
          header: "Mode",
          options: [
            { label: "Fast", description: "Low latency", preview: "**fast**" },
            { label: "Safe", description: "Conservative" },
          ],
        }],
      },
    });
    process.emit("event", {
      type: "interaction.requested",
      id: "request-q1",
      method: "input",
      title: "pi-science-questionnaire-v1:call-q1",
      placeholder: "pi-science-questionnaire-response",
    });
    process.emit("event", { type: "tool.completed", toolCallId: "call-q1", toolName: "ask_user_question", result: "done", isError: false });
    await eventually(() => received.some((event) => event.type === "questionnaire.finished"));

    const questionnaireAsked = received.find((event) => event.type === "questionnaire.asked");
    expect(questionnaireAsked).toMatchObject({ toolCallId: "call-q1" });
    const askedQuestions = questionnaireAsked?.questions as Array<{ options?: Array<Record<string, unknown>> }> | undefined;
    expect(askedQuestions?.[0]?.options?.[0]).toMatchObject({
      label: "Fast",
      preview: "**fast**",
    });
    expect(received.find((event) => event.type === "interaction.requested")).toMatchObject({
      requestId: "request-q1",
      method: "input",
      title: "Questionnaire",
      questionnaire: true,
      toolCallId: "call-q1",
    });
  });

  it("finishes derived artifact publication before session idle", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const received: string[] = [];
    let releaseArtifact!: () => void;
    const artifactReady = new Promise<void>((resolve) => { releaseArtifact = resolve; });
    hub.bind(cwd, process, {
      activeSessionId: () => "session-artifact",
      onBusy: () => undefined,
      onExit: () => undefined,
      observe: async (event, sessionId) => {
        if (event.type !== "tool.completed") return;
        await artifactReady;
        await hub.publish(cwd, sessionId, { type: "artifact.published", sessionId, artifactId: "a1", path: "result.txt" });
      },
    });
    await hub.subscribe(cwd, "session-artifact", undefined, (record) => received.push(JSON.parse(record.data).type));
    process.emit("event", { type: "operation.started" });
    process.emit("event", { type: "tool.completed", toolCallId: "t1", toolName: "write", result: "ok" });
    process.emit("event", { type: "operation.settled", status: "completed" });
    await eventually(() => received.includes("tool.completed"));
    expect(received).not.toContain("operation.settled");
    releaseArtifact();
    await eventually(() => received.includes("operation.settled"));
    expect(received.indexOf("artifact.published")).toBeLessThan(received.indexOf("operation.settled"));
  });

  it("does not attach startup stderr from before the active turn to a later crash", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as RuntimeEventSource;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-stderr", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-stderr", undefined, (record) => received.push(JSON.parse(record.data)));
    process.emit("stderr", "stale startup warning");
    process.emit("event", { type: "operation.started" });
    process.emit("exit", { code: 1, signal: null });
    await eventually(() => received.some((event) => event.terminal === true));
    expect(String(received.find((event) => event.terminal === true)?.message)).not.toContain("stale startup warning");
  });

  it("persists events before subscription and does not duplicate them across subscribers", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    await hub.publish(cwd, "session-late", { type: "message.delta", sessionId: "session-late", text: "early" });

    const first: Array<{ id: string | null; text?: unknown }> = [];
    const second: Array<{ id: string | null; text?: unknown }> = [];
    await hub.subscribe(cwd, "session-late", undefined, (record) => first.push({ id: record.id, ...JSON.parse(record.data) }));
    await hub.subscribe(cwd, "session-late", undefined, (record) => second.push({ id: record.id, ...JSON.parse(record.data) }));
    await hub.publish(cwd, "session-late", { type: "message.delta", sessionId: "session-late", text: "live" });
    await eventually(() => first.length === 2 && second.length === 2);

    expect(first.map((item) => item.text)).toEqual(["early", "live"]);
    expect(second).toEqual(first);
    expect(new Set(first.map((item) => item.id)).size).toBe(2);
  });
});

it("projects Harness facts directly into the v3 product lifecycle", async () => {
  const { AgentCoreEventAdapter } = await import("../agent/agent-event-adapter.js");
  const cwd = await workspace();
  const records: SseEventRecord[] = [];
  const hub = new ConversationEventHub({ append: async (_cwd, _id, record) => { records.push(record); }, readAfter: async () => [] });
  const runtime = new EventEmitter();
  hub.bind(cwd, runtime, { activeSessionId: () => "s", onBusy: () => {}, onExit: () => {} });
  const adapter = new AgentCoreEventAdapter();
  const facts = [
    { type: "run_start", runId: "r" }, { type: "turn_start", runId: "r", turnId: "t" },
    { type: "message_update", runId: "r", message: { role: "assistant", id: "m", content: [{ type: "text", text: "hello" }] }, frame: { type: "text_delta", contentIndex: 0, delta: "hello" } },
    { type: "tool_start", runId: "r", turnId: "t", toolCallId: "c", toolName: "read", args: { path: "a.txt" } },
    { type: "tool_end", runId: "r", turnId: "t", toolCallId: "c", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false },
    { type: "run_end", runId: "r", status: "completed" },
  ];
  for (const fact of facts) for (const input of adapter.adapt({ lane: "main", ...fact } as unknown as import("@earendil-works/pi-agent-core").HarnessEvent)) runtime.emit("event", input);
  await hub.flush();
  const values = records.map((record) => JSON.parse(record.data));
  expect(values.map((value) => value.type)).toEqual(["operation.started", "message.delta", "tool.started", "tool.completed", "operation.settled"]);
  expect(values.every((value) => value.schemaVersion === 3 && value.runId === "r")).toBe(true);
  expect(values.at(-1)).toMatchObject({ status: "completed" });
});

it("publishes one error card when core message and run terminal facts describe the same fault", async () => {
  const cwd = await workspace();
  const records: SseEventRecord[] = [];
  const hub = new ConversationEventHub({ append: async (_cwd, _id, record) => { records.push(record); }, readAfter: async () => [] });
  const process = new EventEmitter();
  hub.bind(cwd, process as RuntimeEventSource, { activeSessionId: () => "s", onBusy: () => {}, onExit: () => {} });
  process.emit("event", { type: "operation.started", runId: "r", turnId: "r" });
  process.emit("event", { type: "message.completed", runId: "r", message: { role: "assistant", stopReason: "error", errorMessage: "provider failed" } });
  process.emit("event", { type: "runtime.error", runId: "r", message: "provider failed" });
  process.emit("event", { type: "operation.settled", runId: "r", status: "failed" });
  await hub.flush();
  const values = records.map((record) => JSON.parse(record.data));
  expect(values.filter((value) => value.type === "error")).toHaveLength(1);
  expect(values).toContainEqual(expect.objectContaining({ type: "operation.settled", outcome: "with_issues" }));
});
