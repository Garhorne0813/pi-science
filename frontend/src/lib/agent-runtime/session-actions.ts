/** Compose stable action groups around the same Zustand set/get handles. */
import type { GetState, SetState, RuntimeActions } from "./actions/types";
import { createConnectionActions } from "./actions/connection";
import { createPromptActions } from "./actions/prompt";
import { createHistoryActions } from "./actions/history";
import { createCommandActions } from "./actions/commands";
import { createQueueActions } from "./actions/queue";
import { createSessionActions } from "./actions/sessions";

export function createRuntimeActions(set: SetState, get: GetState): RuntimeActions {
  return {
    ...createConnectionActions(set, get),
    ...createPromptActions(set, get),
    ...createQueueActions(set, get),
    ...createHistoryActions(set, get),
    ...createCommandActions(set, get),
    ...createSessionActions(set, get),
  };
}
