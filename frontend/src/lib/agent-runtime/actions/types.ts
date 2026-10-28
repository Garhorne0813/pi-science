import type { StoreApi } from "zustand";
import type { RuntimeState } from "../types";

export type SetState = StoreApi<RuntimeState>["setState"];
export type GetState = StoreApi<RuntimeState>["getState"];
export type RuntimeActions = Pick<RuntimeState, "connect" | "disconnect" | "sendPrompt" | "abort" | "setModel" | "respondToInteraction" | "loadSessions" | "loadMoreSessions" | "loadSession" | "loadOlderMessages" | "forkSession" | "createNewSession" | "deleteSession" | "removeSession" | "setDraft">;
