import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ConversationEventHub } from "./conversation-event-hub.js";
import type { SseEventRecord } from "./event-store.js";
type RuntimeEventSource = EventEmitter;

describe("conversation event identities", () => {
  it("preserves durable identities supplied by AgentHarness", async () => {
    const records: SseEventRecord[] = [];
    const hub = new ConversationEventHub({
      append: async (_cwd, _sessionId, record) => { records.push(record); },
      readAfter: async () => [],
    });
    const source = new EventEmitter() as RuntimeEventSource;
    hub.bind("/tmp/pi-science-harness-identity", source, { activeSessionId: () => "session-1", onBusy: () => undefined, onExit: () => undefined });
    source.emit("event", { type: "operation.started", runId: "durable-run", turnId: "durable-turn" });
    source.emit("event", { type: "operation.settled", runId: "durable-run" });
    await hub.flush();
    const start = records.map((record) => JSON.parse(record.data) as Record<string, unknown>).find((record) => record.type === "operation.started");
    expect(start).toMatchObject({ runId: "durable-run", turnId: "durable-turn" });
  });

  it("does not reuse run or turn identities after the hub is recreated", async () => {
    const records: SseEventRecord[] = [];
    const store = {
      append: async (_cwd: string, _sessionId: string, record: SseEventRecord) => { records.push(record); },
      readAfter: async () => [],
      nextSequence: async () => records.length,
    };
    const cwd = "/tmp/pi-science-identity-test";
    const sessionId = "session-restart";

    const firstHub = new ConversationEventHub(store);
    const firstProcess = new EventEmitter() as RuntimeEventSource;
    firstHub.bind(cwd, firstProcess, { activeSessionId: () => sessionId, onBusy: () => undefined, onExit: () => undefined });
    firstProcess.emit("event", { type: "operation.started" });
    firstProcess.emit("event", { type: "operation.settled" });
    await firstHub.flush();

    const firstStart = records.map((record) => JSON.parse(record.data) as Record<string, unknown>).find((event) => event.type === "operation.started");
    expect(firstStart?.runId).toEqual(expect.any(String));
    expect(firstStart?.turnId).toEqual(expect.any(String));

    const secondHub = new ConversationEventHub(store);
    const secondProcess = new EventEmitter() as RuntimeEventSource;
    secondHub.bind(cwd, secondProcess, { activeSessionId: () => sessionId, onBusy: () => undefined, onExit: () => undefined });
    secondProcess.emit("event", { type: "operation.started" });
    await secondHub.flush();

    const starts = records
      .map((record) => JSON.parse(record.data) as Record<string, unknown>)
      .filter((event) => event.type === "operation.started");
    expect(starts).toHaveLength(2);
    expect(starts[1]?.runId).not.toBe(firstStart?.runId);
    expect(starts[1]?.turnId).not.toBe(firstStart?.turnId);
    expect(starts[1]?.streamEpoch).not.toBe(firstStart?.streamEpoch);
  });
});
