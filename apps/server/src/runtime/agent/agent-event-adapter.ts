import type { HarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantContent } from "../events/assistant-content.js";
import type { ProductInput } from "../events/product-input.js";

/** Converts durable Harness facts directly to product input events. */
export function adaptHarnessEvent(event: HarnessEvent): ProductInput[] {
  switch (event.type) {
    case "compaction_start":
      return [{ type: "compaction.start", runId: event.runId, reason: event.reason }];
    case "compaction_end":
      return event.status === "failed"
        ? [{ type: "compaction.error", runId: event.runId, message: event.error.message },
          { type: "runtime.error", runId: event.runId, message: event.error.message }]
        : [{ type: "compaction.end", runId: event.runId, reason: event.reason, outcome: event.status }];
    case "run_start":
      return [{ type: "operation.started", runId: event.runId }];
    case "run_end":
      return [
        ...(event.status === "failed" ? [{ type: "runtime.error" as const, runId: event.runId, message: event.error.message }] : []),
        { type: "operation.settled", runId: event.runId, status: event.status },
      ];
    case "turn_start":
      return [{ type: "model.turn.started", runId: event.runId, turnId: event.turnId }];
    case "message_start":
      return [{ type: "message.started", runId: event.runId, message: event.message }];
    case "message_end":
      return [{ type: "message.completed", runId: event.runId, message: event.message },
        ...(event.message.role === "assistant" && event.message.stopReason === "error" && event.message.errorMessage
          ? [{ type: "runtime.error" as const, runId: event.runId, message: event.message.errorMessage }] : [])];
    case "message_update": {
      if (event.message.role !== "assistant") return [];
      const update = event.frame ?? event.event;
      const kind = update.type.startsWith("thinking_") ? "thinking" : "text";
      if (!["text_delta", "text_end", "thinking_delta", "thinking_end"].includes(update.type)) return [];
      const part = event.message.content["contentIndex" in update ? update.contentIndex : 0];
      const snapshot = part?.type === "text" ? part.text : part?.type === "thinking" ? part.thinking : undefined;
      const text = "delta" in update ? update.delta : "content" in update ? update.content : "";
      const content: AssistantContent = {
        kind, type: update.type, text: typeof text === "string" ? text : "",
        messageId: "id" in event.message && typeof event.message.id === "string" ? event.message.id : "",
        contentIndex: String("contentIndex" in update ? update.contentIndex : 0),
        ...(event.frame || snapshot === undefined ? {} : { snapshot }),
      };
      return [{ type: "message.updated", runId: event.runId,
        message: { role: "assistant", ...(content.messageId ? { id: content.messageId } : {}) }, content }];
    }
    case "tool_start":
      return [{ type: "tool.started", runId: event.runId, turnId: event.turnId, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }];
    case "tool_update":
      return [{ type: "tool.updated", runId: event.runId, turnId: event.turnId, toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult }];
    case "tool_end":
      return [{ type: "tool.completed", runId: event.runId, turnId: event.turnId, toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError }];
    case "fault":
      return [{ type: "runtime.error", code: event.code, message: event.message }];
    case "retry_start":
    case "retry_end":
      return [{ type: event.type === "retry_start" ? "retry.start" : "retry.end", runId: event.runId, step: event.step, attempt: event.attempt }];
    case "retry_scheduled":
      return [{ type: "retry.update", runId: event.runId, step: event.step, attempt: event.attempt, message: event.errorMessage }];
    default:
      return [];
  }
}

/** One stable product turn per durable run; internal model/tool turns stay separate. */
export class AgentCoreEventAdapter {
  private pendingRunId: string | null = null;
  private started = false;
  private earlyEvents: ProductInput[] = [];
  private readonly toolArgs = new Map<string, unknown>();

  beginRecovery(runId: string): ProductInput {
    this.pendingRunId = runId;
    this.started = true;
    this.earlyEvents = [];
    this.toolArgs.clear();
    return { type: "operation.started", runId, turnId: runId, recovery: true };
  }

  adapt(event: HarnessEvent): ProductInput[] {
    if (event.type === "tool_start") this.toolArgs.set(event.toolCallId, event.args);
    let toolEnd: ProductInput[] | undefined;
    if (event.type === "tool_end") {
      const args = this.toolArgs.get(event.toolCallId);
      this.toolArgs.delete(event.toolCallId);
      toolEnd = [{ type: "tool.completed", runId: event.runId, turnId: event.turnId,
        toolCallId: event.toolCallId, toolName: event.toolName, args,
        result: event.result, details: event.result.details, isError: event.isError }];
    }
    if (event.type === "run_start") {
      this.toolArgs.clear();
      this.pendingRunId = event.runId;
      this.started = false;
      this.earlyEvents = [];
      return [];
    }
    if (event.type === "run_resume") {
      if (this.pendingRunId === event.runId && this.started) return [];
      return [this.beginRecovery(event.runId)];
    }
    if (event.type === "turn_start" && this.pendingRunId === event.runId && !this.started) {
      this.started = true;
      const early = this.earlyEvents;
      this.earlyEvents = [];
      return [{ type: "operation.started", runId: event.runId, turnId: event.runId }, ...early];
    }
    // A manual compaction is its own durable operation. Core reports it with
    // compaction_start and compaction_end rather than run_start and run_end, so
    // without this boundary it would never be supervised: no expected operation,
    // no watchdog, and a settings reload would treat the worker as idle.
    if ((event.type === "compaction_start" || event.type === "compaction_end") && event.reason === "manual" && this.pendingRunId === null) {
      const compaction = adaptHarnessEvent(event);
      return event.type === "compaction_start"
        ? [{ type: "operation.started", runId: event.runId, turnId: event.runId }, ...compaction]
        : [...compaction, { type: "operation.settled", runId: event.runId, status: event.status, handledWithoutTurn: true }];
    }
    const mapped = toolEnd ?? adaptHarnessEvent(event);
    if (event.type === "run_end" && this.pendingRunId === event.runId) {
      const early = this.earlyEvents;
      const start: ProductInput[] = this.started ? [] : [{ type: "operation.started", runId: event.runId, turnId: event.runId }];
      this.pendingRunId = null;
      this.started = false;
      this.earlyEvents = [];
      return [...start, ...early, ...mapped];
    }
    if (this.pendingRunId && !this.started) {
      this.earlyEvents.push(...mapped);
      return [];
    }
    return mapped;
  }
}
