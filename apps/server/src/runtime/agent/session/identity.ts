import { WorkspaceLifecycleBusyError } from "../../workspace/workspace-lifecycle.js";
import { createHash } from "node:crypto";
import { workspaceIdentity } from "../workspace-session-identity.js";
import { workspaceFile } from "../../../storage/persistence.js";
import type { RuntimeResult } from "../agent-runtime-types.js";
import { AgentRuntimeExitedError, AgentRuntimeTimeoutError } from "../agent-runtime-errors.js";

export function identity(cwd: string, id: string): string { return `${workspaceIdentity(cwd)}\0${id}`; }

export const OPERATION_PROGRESS_EVENTS = new Set([
  "model.turn.started", "message.started", "message.updated", "message.completed",
  "tool.started", "tool.updated", "tool.completed", "compaction.start", "compaction.end",
  "retry.start", "retry.update", "retry.end",
]);

export function noProgressTimeoutMs(): number {
  const value = Number(process.env.PI_SCIENCE_OPERATION_NO_PROGRESS_MS ?? 15 * 60_000);
  return Number.isFinite(value) && value > 0 ? value : 15 * 60_000;
}

export function configPath(cwd: string, sessionId: string): string {
  return workspaceFile(cwd, `agent-session-config/${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

export function splitModel(model: string | null | undefined): { provider: string; modelId: string } | null {
  const index = model?.indexOf("/") ?? -1;
  return index > 0 && index < model!.length - 1 ? { provider: model!.slice(0, index), modelId: model!.slice(index + 1) } : null;
}

export function thinking(value: string | null | undefined): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  return value && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
    ? value as ReturnType<typeof thinking> : "high";
}

export function failed(error: unknown): RuntimeResult<never> {
  const code = error instanceof WorkspaceLifecycleBusyError ? "busy" : error instanceof AgentRuntimeTimeoutError ? "timeout"
    : error instanceof AgentRuntimeExitedError ? "process_exit" : "runtime_command_failed";
  return { success: false, code, error: error instanceof Error ? error.message : String(error) };
}
