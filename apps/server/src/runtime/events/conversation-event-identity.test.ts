import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ConversationEventHub } from "./conversation-event-hub.js";
import type { SseEventRecord } from "./event-store.js";
import type { PiProcess } from "../pi/pi-process.js";

describe("conversation event identities", () => {
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
    const firstProcess = new EventEmitter() as PiProcess;
    firstHub.bind(cwd, firstProcess, { activeSessionId: () => sessionId, onBusy: () => undefined, onExit: () => undefined });
    firstProcess.emit("event", { type: "agent_start" });
    firstProcess.emit("event", { type: "agent_settled" });
    await firstHub.flush();

    const firstStart = records.map((record) => JSON.parse(record.data) as Record<string, unknown>).find((event) => event.type === "agent_start");
    expect(firstStart?.runId).toEqual(expect.any(String));
    expect(firstStart?.turnId).toEqual(expect.any(String));

    const secondHub = new ConversationEventHub(store);
    const secondProcess = new EventEmitter() as PiProcess;
    secondHub.bind(cwd, secondProcess, { activeSessionId: () => sessionId, onBusy: () => undefined, onExit: () => undefined });
    secondProcess.emit("event", { type: "agent_start" });
    await secondHub.flush();

    const starts = records
      .map((record) => JSON.parse(record.data) as Record<string, unknown>)
      .filter((event) => event.type === "agent_start");
    expect(starts).toHaveLength(2);
    expect(starts[1]?.runId).not.toBe(firstStart?.runId);
    expect(starts[1]?.turnId).not.toBe(firstStart?.turnId);
    expect(starts[1]?.streamEpoch).toBe(firstStart?.streamEpoch);
  });
});
