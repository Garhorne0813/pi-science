import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationEventHub } from "./conversation-event-hub.js";
import type { SseEventRecord } from "./event-store.js";
import type { PiProcess } from "./pi-process.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
    const hub = new ConversationEventHub(store);
    const received: SseEventRecord[] = [];
    const subscribing = hub.subscribe(cwd, "session-race", undefined, (event) => received.push(event));
    await started;
    await hub.publish(cwd, "session-race", { type: "text.updated", sessionId: "session-race", text: "once" });
    releaseRead();
    await subscribing;

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.data).text).toBe("once");
  });

  it("preserves exact message_end errors and emits one durable event per Pi event", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as PiProcess;
    const first: Array<{ id: string | null; data: Record<string, unknown> }> = [];
    const second: Array<{ id: string | null; data: Record<string, unknown> }> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-1", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-1", undefined, (record) => first.push({ id: record.id, data: JSON.parse(record.data) }));
    await hub.subscribe(cwd, "session-1", undefined, (record) => second.push({ id: record.id, data: JSON.parse(record.data) }));

    process.emit("event", { type: "agent_start" });
    process.emit("event", { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "OpenAI API error (401): Invalid API key" } });
    process.emit("event", { type: "agent_settled" });
    await eventually(() => first.length === 3 && second.length === 3);

    expect(first.map((item) => item.data.type)).toEqual(["agent_start", "error", "session.idle"]);
    expect(first[1]?.data.message).toContain("Invalid API key");
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));

    const replay: Array<Record<string, unknown>> = [];
    await hub.subscribe(cwd, "session-1", first[0]?.id ?? undefined, (record) => replay.push(JSON.parse(record.data)));
    expect(replay.map((item) => item.type)).toEqual(["error", "session.idle"]);
  });

  it("deduplicates final text after deltas and surfaces process exits", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as PiProcess;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-2", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-2", undefined, (record) => received.push(JSON.parse(record.data)));
    process.emit("event", { type: "agent_start" });
    process.emit("event", { type: "message_update", message: { id: "m1" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "OK" } });
    process.emit("event", { type: "message_update", message: { id: "m1" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "OK" } });
    process.emit("event", { type: "agent_settled" });
    process.emit("stderr", "fatal adapter error");
    process.emit("exit", { code: 1, signal: null });
    await eventually(() => received.some((event) => event.terminal === true));
    expect(received.filter((event) => event.type === "text.updated").map((event) => event.text)).toEqual(["OK"]);
    expect(received.find((event) => event.terminal === true)?.message).toContain("fatal adapter error");
  });

  it("emits only the missing final-text suffix and isolates anonymous messages", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as PiProcess;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-text", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-text", undefined, (record) => received.push(JSON.parse(record.data)));

    process.emit("event", { type: "agent_start" });
    process.emit("event", { type: "message_update", message: { id: "m1" }, assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
    process.emit("event", { type: "message_update", message: { id: "m1" }, assistantMessageEvent: { type: "text_end", content: "Hello" } });
    process.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_end", content: "First" } });
    process.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_end", content: "Second" } });
    process.emit("event", { type: "message_update", message: { id: "m2" }, assistantMessageEvent: { type: "text_delta", delta: "old" } });
    process.emit("event", { type: "message_update", message: { id: "m2" }, assistantMessageEvent: { type: "text_end", content: "replacement" } });
    process.emit("event", { type: "agent_settled" });
    await eventually(() => received.some((event) => event.type === "session.idle"));

    const text = received.filter((event) => event.type === "text.updated");
    expect(text.slice(0, 2).map((event) => event.text)).toEqual(["Hel", "lo"]);
    expect(text[2]?.partId).not.toBe(text[3]?.partId);
    expect(text.at(-1)).toMatchObject({ text: "replacement", replace: true, partId: "m2" });
  });

  it("does not classify tool, interaction, or artifact-only turns as empty", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as PiProcess;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-activity", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-activity", undefined, (record) => received.push(JSON.parse(record.data)));

    for (const event of [
      { type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "ok" },
      { type: "extension_ui_request", method: "confirm", id: "q1", message: "continue?" },
      { type: "artifact_published", artifactId: "a1", path: "result.txt" },
    ]) {
      process.emit("event", { type: "agent_start" });
      process.emit("event", event);
      process.emit("event", { type: "agent_settled" });
    }
    await eventually(() => received.filter((event) => event.type === "session.idle").length === 3);
    expect(received.filter((event) => event.type === "error")).toEqual([]);
  });

  it("finishes derived artifact publication before session idle", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as PiProcess;
    const received: string[] = [];
    let releaseArtifact!: () => void;
    const artifactReady = new Promise<void>((resolve) => { releaseArtifact = resolve; });
    hub.bind(cwd, process, {
      activeSessionId: () => "session-artifact",
      onBusy: () => undefined,
      onExit: () => undefined,
      observe: async (event, sessionId) => {
        if (event.type !== "tool_execution_end") return;
        await artifactReady;
        await hub.publish(cwd, sessionId, { type: "artifact.published", sessionId, artifactId: "a1", path: "result.txt" });
      },
    });
    await hub.subscribe(cwd, "session-artifact", undefined, (record) => received.push(JSON.parse(record.data).type));
    process.emit("event", { type: "agent_start" });
    process.emit("event", { type: "tool_execution_end", toolCallId: "t1", toolName: "write", result: "ok" });
    process.emit("event", { type: "agent_settled" });
    await eventually(() => received.includes("tool.updated"));
    expect(received).not.toContain("session.idle");
    releaseArtifact();
    await eventually(() => received.includes("session.idle"));
    expect(received.indexOf("artifact.published")).toBeLessThan(received.indexOf("session.idle"));
  });

  it("does not attach startup stderr from before the active turn to a later crash", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as PiProcess;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-stderr", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-stderr", undefined, (record) => received.push(JSON.parse(record.data)));
    process.emit("stderr", "stale startup warning");
    process.emit("event", { type: "agent_start" });
    process.emit("exit", { code: 1, signal: null });
    await eventually(() => received.some((event) => event.terminal === true));
    expect(String(received.find((event) => event.terminal === true)?.message)).not.toContain("stale startup warning");
  });

  it("persists events before subscription and does not duplicate them across subscribers", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    await hub.publish(cwd, "session-late", { type: "text.updated", sessionId: "session-late", text: "early" });

    const first: Array<{ id: string | null; text?: unknown }> = [];
    const second: Array<{ id: string | null; text?: unknown }> = [];
    await hub.subscribe(cwd, "session-late", undefined, (record) => first.push({ id: record.id, ...JSON.parse(record.data) }));
    await hub.subscribe(cwd, "session-late", undefined, (record) => second.push({ id: record.id, ...JSON.parse(record.data) }));
    await hub.publish(cwd, "session-late", { type: "text.updated", sessionId: "session-late", text: "live" });
    await eventually(() => first.length === 2 && second.length === 2);

    expect(first.map((item) => item.text)).toEqual(["early", "live"]);
    expect(second).toEqual(first);
    expect(new Set(first.map((item) => item.id)).size).toBe(2);
  });
});
