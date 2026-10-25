import type { SessionState } from "../../client/pi-science-client";

export function runtimeKey(sessionId: string, cwd: string): string {
  return `${cwd}\u0000${sessionId}`;
}

export function runtimeBusy(runtimeState: SessionState): boolean {
  return runtimeState.is_streaming
    || runtimeState.is_compacting
    || runtimeState.pending_message_count > 0;
}
