import type { HarnessEvent } from "@earendil-works/pi-agent-core";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentCoreEventAdapter } from "./agent-event-adapter.js";
import { observeNodePiEvent } from "../events/node-event-observer.js";

function event(value: Record<string, unknown>): HarnessEvent {
  return { lane: "main", ...value } as unknown as HarnessEvent;
}

describe("AgentCoreEventAdapter", () => {
  it("forwards manual and automatic compaction outcomes through existing browser events", () => {
    const adapter = new AgentCoreEventAdapter();
    expect(adapter.adapt(event({ type: "compaction_start", runId: "compact", reason: "manual" })))
      .toEqual([{ type: "compaction.start", runId: "compact", reason: "manual" }]);
    expect(adapter.adapt(event({ type: "compaction_end", runId: "compact", reason: "manual", status: "aborted" })))
      .toEqual([{ type: "compaction.end", runId: "compact", reason: "manual", outcome: "aborted" }]);
    expect(adapter.adapt(event({ type: "compaction_end", runId: "compact", status: "failed", error: { message: "summary failed" } })))
      .toEqual([{ type: "compaction.error", runId: "compact", message: "summary failed" }, { type: "runtime.error", runId: "compact", message: "summary failed" }]);
  });
  it("does not duplicate the lifecycle start when recovery also emits run_resume", () => {
    const adapter = new AgentCoreEventAdapter();
    expect(adapter.beginRecovery("recovered-run")).toMatchObject({ type: "operation.started", runId: "recovered-run", recovery: true });
    expect(adapter.adapt(event({ type: "run_resume", runId: "recovered-run" }))).toEqual([]);
    expect(adapter.adapt(event({ type: "run_end", runId: "recovered-run", status: "completed" })))
      .toEqual([{ type: "operation.settled", runId: "recovered-run", status: "completed" }]);
  });
  it("keeps the harness run and turn identities through the browser event shape", () => {
    const adapter = new AgentCoreEventAdapter();
    expect(adapter.adapt(event({ type: "run_start", runId: "run-1", startedAt: 1 }))).toEqual([]);
    expect(adapter.adapt(event({ type: "message_start", runId: "run-1", message: { role: "user", content: "hello" } }))).toEqual([]);
    expect(adapter.adapt(event({ type: "turn_start", runId: "run-1", turnId: "turn-1" }))).toMatchObject([
      { type: "operation.started", runId: "run-1", turnId: "run-1" },
      { type: "message.started", runId: "run-1" },
    ]);
    expect(adapter.adapt(event({ type: "tool_start", runId: "run-1", turnId: "turn-1", toolCallId: "tool-1", toolName: "read", args: {} }))).toEqual([
      { type: "tool.started", runId: "run-1", turnId: "turn-1", toolCallId: "tool-1", toolName: "read", args: {} },
    ]);
    expect(adapter.adapt(event({ type: "tool_end", runId: "run-1", turnId: "turn-1", toolCallId: "tool-1", toolName: "read", result: { content: [] }, isError: false }))).toEqual([
      { type: "tool.completed", runId: "run-1", turnId: "turn-1", toolCallId: "tool-1", toolName: "read", args: {}, result: { content: [] }, isError: false },
    ]);
    expect(adapter.adapt(event({ type: "run_end", runId: "run-1", status: "completed", fromTipId: null, tipId: "entry-1", endedAt: 2 }))).toEqual([
      { type: "operation.settled", runId: "run-1", status: "completed" },
    ]);
  });

  it("settles a run that failed before its first turn", () => {
    const adapter = new AgentCoreEventAdapter();
    adapter.adapt(event({ type: "run_start", runId: "run-2", startedAt: 1 }));
    expect(adapter.adapt(event({ type: "run_end", runId: "run-2", status: "failed", error: { code: "auth", message: "missing key" }, fromTipId: null, tipId: null, endedAt: 2 }))).toEqual([
      { type: "operation.started", runId: "run-2", turnId: "run-2" },
      { type: "runtime.error", runId: "run-2", message: "missing key" },
      { type: "operation.settled", runId: "run-2", status: "failed" },
    ]);
  });

  it("publishes assistant provider errors instead of leaving an empty reply", () => {
    const adapter = new AgentCoreEventAdapter();
    expect(adapter.adapt(event({ type: "message_end", runId: "run", message: {
      role: "assistant", content: [], stopReason: "error", errorMessage: "Provider is not configured: deepseek",
    } }))).toEqual([
      { type: "message.completed", runId: "run", message: expect.any(Object) },
      { type: "runtime.error", runId: "run", message: "Provider is not configured: deepseek" },
    ]);
  });

  it("uses replay frames instead of a later mutable assistant snapshot", () => {
    const adapter = new AgentCoreEventAdapter();
    const mapped = adapter.adapt(event({ type: "message_update", runId: "r",
      message: { role: "assistant", content: [{ type: "text", text: "aab" }] },
      event: { type: "text_delta", contentIndex: 0, delta: "ab" },
      frame: { type: "text_delta", contentIndex: 0, delta: "a" },
    }));
    expect(mapped).toEqual([expect.objectContaining({ type: "message.updated", content: {
      source: "core", kind: "text", type: "text_delta", text: "a", messageId: "", contentIndex: "0",
    } })]);
    expect(mapped[0]).not.toHaveProperty("assistantMessageEvent");
    expect(mapped[0]!.message).toEqual({ role: "assistant" });
  });

  it("keeps write arguments available for artifact tracking", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-artifact-"));
    try {
      await writeFile(join(cwd, "result.txt"), "result");
      const adapter = new AgentCoreEventAdapter();
      const start = adapter.adapt(event({ type: "tool_start", runId: "run", turnId: "turn",
        toolCallId: "call", toolName: "write", args: { path: "result.txt", content: "result" } }));
      const end = adapter.adapt(event({ type: "tool_end", runId: "run", turnId: "turn",
        toolCallId: "call", toolName: "write", result: { content: [{ type: "text", text: "ok" }] }, isError: false }));
      const published: Record<string, unknown>[] = [];
      for (const item of [...start, ...end]) await observeNodePiEvent(cwd, "openai/gpt-4.1-mini", item, "session",
        async (payload) => { published.push(payload); });
      expect(published).toEqual([expect.objectContaining({ type: "artifact.published", path: "result.txt" })]);
      const manifests = await readFile(join(cwd, ".pi-science", "artifacts.jsonl"), "utf8");
      expect(manifests).toContain('"path":"result.txt"');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
