/** Inline error rendering and missing-session detection for the runtime store. */

import type { ThreadBlock } from "../../types/thread";
import { useRuntimeStore } from "./store";

/** Disambiguates errors rendered within the same millisecond. */
let _errorSequence = 0;

export function appendRuntimeError(
  error: unknown,
  sessionId?: string | null,
  cwd?: string,
): void {
  const current = useRuntimeStore.getState();
  if (sessionId && current.activeSessionId !== sessionId) return;
  if (cwd && current.cwd !== cwd) return;
  const errorBlock: ThreadBlock = {
    kind: "status-line",
    id: `error-${Date.now()}-${++_errorSequence}`,
    text: error instanceof Error ? error.message : "Unable to complete the request",
    level: "error",
  };
  const nextBlocks = [...current.thread.blocks, errorBlock];
  useRuntimeStore.setState({
    thread: {
      blocks: nextBlocks,
      index: { ...current.thread.index, [errorBlock.id]: nextBlocks.length - 1 },
      loaded: true,
    },
  });
}

export function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return normalized.includes("session not found in this workspace")
    || normalized.includes("session is not active in this workspace")
    || normalized.includes("session not active in this workspace");
}
