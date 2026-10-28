/** One copy-on-write projection transaction dispatches to exactly one event-family reducer. */
import type { PiScienceEvent } from "../../client/pi-science-client";
import type { Thread, FoldDraft } from "./types";
import { cloneFoldState, withFoldState } from "./state";
import { reduceMessageEvent } from "./message-events";
import { reduceToolEvent } from "./tool-events";
import { reduceArtifactEvent } from "./artifact-events";
import { reduceRuntimeEvent } from "./runtime-events";

export function foldProductEvent(state: Thread, event: PiScienceEvent): Thread {
  const foldState = cloneFoldState(state, event);
  if (foldState.sessionId && event.sessionId && foldState.sessionId !== event.sessionId) return state;
  if (event.sessionId) foldState.sessionId = event.sessionId;
  if (event.streamEpoch) foldState.streamEpoch = String(event.streamEpoch);
  const blocks = [...state.blocks];
  const index = { ...state.index };

  const draft: FoldDraft = { foldState, blocks, index };
  switch (event.type) {
    case "message.started":
    case "message.completed":
    case "message.delta":
    case "message.reasoning.delta":
      reduceMessageEvent(event, draft);
      break;
    case "tool.started":
    case "tool.completed":
    case "tool.updated":
      reduceToolEvent(event, draft);
      break;
    case "artifact.published":
    case "artifact.updated":
    case "turn.artifacts":
      reduceArtifactEvent(event, draft);
      break;
    case "operation.started":
    case "compaction.started":
    case "compaction.completed":
    case "compaction.failed":
    case "compaction.progress":
    case "plan.updated":
    case "status.updated":
    case "runtime.paused":
    case "operation.settled":
    case "error":
      reduceRuntimeEvent(event, draft);
      break;
  }
  return withFoldState({ blocks, index, loaded: true }, foldState);
}
