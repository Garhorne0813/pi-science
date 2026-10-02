import type { HarnessEvent } from "@earendil-works/pi-agent-core";
import type { RuntimeEvent } from "./agent-runtime-types.js";

/** Converts durable harness events to the first-stage Pi browser event shape. */
export function adaptHarnessEvent(event: HarnessEvent): RuntimeEvent[] {
  switch (event.type) {
    case "compaction_start":
      return [{ type: "compaction_start", runId: event.runId, reason: event.reason }];
    case "compaction_end":
      return event.status === "failed"
        ? [{ type: "compaction_error", runId: event.runId, message: event.error.message },
          { type: "error", runId: event.runId, message: event.error.message }]
        : [{ type: "compaction_end", runId: event.runId, reason: event.reason, outcome: event.status }];
    case "run_start":
      return [{ type: "agent_start", runId: event.runId }];
    case "run_end":
      return [
        ...(event.status === "failed" ? [{ type: "error", runId: event.runId, message: event.error.message }] : []),
        { type: "agent_settled", runId: event.runId, status: event.status },
      ];
    case "turn_start":
      return [{ type: "turn_start", runId: event.runId, turnId: event.turnId }];
    case "message_start":
      return [{ type: event.type, runId: event.runId, message: event.message }];
    case "message_end":
      return [{ type: event.type, runId: event.runId, message: event.message },
        ...(event.message.role === "assistant" && event.message.stopReason === "error" && event.message.errorMessage
          ? [{ type: "error", runId: event.runId, message: event.message.errorMessage }] : [])];
    case "message_update":
      return [{ type: "message_update", runId: event.runId, message: event.message, assistantMessageEvent: event.event }];
    case "tool_start":
      return [{ type: "tool_execution_start", runId: event.runId, turnId: event.turnId, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }];
    case "tool_update":
      return [{ type: "tool_execution_update", runId: event.runId, turnId: event.turnId, toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult }];
    case "tool_end":
      return [{ type: "tool_execution_end", runId: event.runId, turnId: event.turnId, toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError }];
    case "fault":
      return [{ type: "error", code: event.code, message: event.message }];
    case "retry_start":
    case "retry_end":
      return [{ type: event.type, runId: event.runId, step: event.step, attempt: event.attempt }];
    case "retry_scheduled":
      return [{ type: "retry_update", runId: event.runId, step: event.step, attempt: event.attempt, message: event.errorMessage }];
    default:
      return [];
  }
}

/** One stable product turn per durable run; internal model/tool turns stay separate. */
export class AgentCoreEventAdapter {
  private pendingRunId: string | null = null;
  private started = false;
  private earlyEvents: RuntimeEvent[] = [];
  private readonly toolArgs = new Map<string, unknown>();

  beginRecovery(runId: string): RuntimeEvent {
    this.pendingRunId = runId;
    this.started = true;
    this.earlyEvents = [];
    this.toolArgs.clear();
    return { type: "agent_start", runId, turnId: runId, recovery: true };
  }

  adapt(event: HarnessEvent): RuntimeEvent[] {
    if (event.type === "tool_start") this.toolArgs.set(event.toolCallId, event.args);
    let toolEnd: RuntimeEvent[] | undefined;
    if (event.type === "tool_end") {
      const args = this.toolArgs.get(event.toolCallId);
      this.toolArgs.delete(event.toolCallId);
      toolEnd = [{ type: "tool_execution_end", runId: event.runId, turnId: event.turnId,
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
      return [{ type: "agent_start", runId: event.runId, turnId: event.runId }, ...early];
    }
    const mapped = toolEnd ?? adaptHarnessEvent(event);
    if (event.type === "run_end" && this.pendingRunId === event.runId) {
      const early = this.earlyEvents;
      const start = this.started ? [] : [{ type: "agent_start", runId: event.runId, turnId: event.runId }];
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
