import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationEventHub } from "./conversation-event-hub.js";
import { DurableEventStore, type SseEventRecord } from "./event-store.js";
import type { PiProcess } from "../pi/pi-process.js";

const workspaces: string[] = [];

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
    await hub.publish(cwd, "session-live", { type: "session.idle", sessionId: "session-live" });

    expect(readCalled).toBe(false);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.data)).toMatchObject({ type: "session.idle", sessionId: "session-live" });
    unsubscribe();
    expect(hub.hasSubscribers(cwd, "session-live")).toBe(false);
  });

  it("does not append or deliver a guarded publication that is invalid before publishing", async () => {
    const cwd = await workspace();
    let allowed = false;
    const appended: SseEventRecord[] = [];
    const store = {
      append: async (_cwd: string, _sessionId: string, record: SseEventRecord) => { appended.push(record); },
      readAfter: async () => [],
    };
    const hub = new ConversationEventHub(store);
    const received: SseEventRecord[] = [];
    await hub.subscribe(cwd, "session-guarded", undefined, (record) => received.push(record), false);

    await hub.publish(cwd, "session-guarded", { type: "session.idle", sessionId: "session-guarded" }, () => allowed);

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
    const hub = new ConversationEventHub(store);
    const received: SseEventRecord[] = [];
    await hub.subscribe(cwd, "session-window", undefined, (record) => received.push(record), false);

    const publishing = hub.publish(cwd, "session-window", { type: "session.idle", sessionId: "session-window" }, () => allowed);
    await appendReady;
    allowed = false;
    releaseAppend();
    await publishing;

    expect(appended).toHaveLength(0);
    expect(received).toHaveLength(0);

    await hub.publish(cwd, "session-window", { type: "agent_start", sessionId: "session-window" });
    expect(received.map((record) => JSON.parse(record.data).type)).toEqual(["agent_start"]);
    expect(received[0]?.id).toBe("1");
  });

  it("re-delivers pending interactions to a fresh subscriber without a cursor", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub({
      append: async () => undefined,
      readAfter: async () => [],
    });
    await hub.publish(cwd, "session-pending", { type: "questionnaire.asked", sessionId: "session-pending", toolCallId: "call-q1", questions: [] });
    await hub.publish(cwd, "session-pending", { type: "question.asked", sessionId: "session-pending", requestId: "request-q1", questionnaire: true, toolCallId: "call-q1" });

    const received: string[] = [];
    await hub.subscribe(cwd, "session-pending", undefined, (record) => {
      received.push(JSON.parse(record.data).type as string);
    }, false);

    expect(received).toEqual(["questionnaire.asked", "question.asked"]);
  });

  it("keeps only the latest generic interaction for refresh recovery", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub({ append: async () => undefined, readAfter: async () => [] });
    await hub.publish(cwd, "session-generic", { type: "question.asked", sessionId: "session-generic", requestId: "request-1" });
    await hub.publish(cwd, "session-generic", { type: "question.asked", sessionId: "session-generic", requestId: "request-2" });

    const received: Record<string, unknown>[] = [];
    await hub.subscribe(cwd, "session-generic", undefined, (record) => {
      received.push(JSON.parse(record.data));
    }, false);

    expect(received).toEqual([expect.objectContaining({ type: "question.asked", requestId: "request-2" })]);
  });

  it("removes the questionnaire pair when its interaction is resolved", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub({ append: async () => undefined, readAfter: async () => [] });
    await hub.publish(cwd, "session-resolved", { type: "questionnaire.asked", sessionId: "session-resolved", toolCallId: "call-q1", questions: [] });
    await hub.publish(cwd, "session-resolved", { type: "question.asked", sessionId: "session-resolved", requestId: "request-q1", questionnaire: true, toolCallId: "call-q1" });
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
    await hub.publish(cwd, "session-resolved", { type: "question.asked", sessionId: "session-resolved", requestId: "request-q1" });
    await hub.publish(cwd, "session-resolved", { type: "questionnaire.finished", sessionId: "session-resolved", toolCallId: "call-q1" });

    const received: SseEventRecord[] = [];
    await hub.subscribe(cwd, "session-resolved", undefined, (record) => received.push(record), false);

    expect(received).toHaveLength(0);
  });

  it("reports pending interactions for attention without mutating state", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub({ append: async () => undefined, readAfter: async () => [] });
    expect(hub.hasPendingInteraction(cwd, "session-attention")).toBe(false);

    await hub.publish(cwd, "session-attention", { type: "question.asked", sessionId: "session-attention", requestId: "request-q1" });
    expect(hub.hasPendingInteraction(cwd, "session-attention")).toBe(true);

    hub.resolvePendingInteraction(cwd, "session-attention", "request-q1");
    expect(hub.hasPendingInteraction(cwd, "session-attention")).toBe(false);
    // A different session stays unaffected.
    expect(hub.hasPendingInteraction(cwd, "session-other")).toBe(false);
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
    expect(text).toHaveLength(4);
    expect(text[0]).toMatchObject({ text: "Hello", partId: "m1" });
    expect(text[1]?.partId).not.toBe(text[2]?.partId);
    expect(text.at(-1)).toMatchObject({ text: "replacement", replace: true, partId: "m2" });
  });

  it("uses partial snapshots to discard repeated and overlapping streaming deltas", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as PiProcess;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-overlap", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-overlap", undefined, (record) => received.push(JSON.parse(record.data)));

    const partial = (value: string) => ({
      role: "assistant",
      content: [{ type: "text", text: value }],
    });
    const emitDelta = (delta: string, snapshot: string) => process.emit("event", {
      type: "message_update",
      message: { id: "m-overlap" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: partial(snapshot) },
    });

    process.emit("event", { type: "agent_start" });
    emitDelta("生成出版级图表(matplotlib，带单位", "生成出版级图表(matplotlib，带单位");
    // Duplicate delivery: no new text in the authoritative snapshot.
    emitDelta("生成出版级图表(matplotlib，带单位", "生成出版级图表(matplotlib，带单位");
    // Provider chunk overlaps the previous chunk, but the snapshot advances
    // by only the non-overlapping suffix.
    emitDelta("图表(matplotlib，带单位标注、色盲友好配色", "生成出版级图表(matplotlib，带单位标注、色盲友好配色");
    process.emit("event", { type: "agent_settled" });
    await eventually(() => received.some((event) => event.type === "session.idle"));

    expect(received.filter((event) => event.type === "text.updated").map((event) => event.text).join(""))
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

    expect(first[0]?.id).toBe("1");
    expect(all.map((record) => record.id)).toEqual(["1", "2"]);
    expect((await store.readAfter(cwd, "session-restart", first[0]?.id)).map((record) => record.id)).toEqual(["2"]);
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

  it("publishes a structured questionnaire and marks its browser response request", async () => {
    const cwd = await workspace();
    const hub = new ConversationEventHub();
    const process = new EventEmitter() as PiProcess;
    const received: Array<Record<string, unknown>> = [];
    hub.bind(cwd, process, { activeSessionId: () => "session-questionnaire", onBusy: () => undefined, onExit: () => undefined });
    await hub.subscribe(cwd, "session-questionnaire", undefined, (record) => received.push(JSON.parse(record.data)));

    process.emit("event", { type: "agent_start" });
    process.emit("event", {
      type: "tool_execution_start",
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
      type: "extension_ui_request",
      id: "request-q1",
      method: "input",
      title: "pi-science-questionnaire-v1:call-q1",
      placeholder: "pi-science-questionnaire-response",
    });
    process.emit("event", { type: "tool_execution_end", toolCallId: "call-q1", toolName: "ask_user_question", result: "done", isError: false });
    await eventually(() => received.some((event) => event.type === "questionnaire.finished"));

    const questionnaireAsked = received.find((event) => event.type === "questionnaire.asked");
    expect(questionnaireAsked).toMatchObject({ toolCallId: "call-q1" });
    const askedQuestions = questionnaireAsked?.questions as Array<{ options?: Array<Record<string, unknown>> }> | undefined;
    expect(askedQuestions?.[0]?.options?.[0]).toMatchObject({
      label: "Fast",
      preview: "**fast**",
    });
    expect(received.find((event) => event.type === "question.asked")).toMatchObject({
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
