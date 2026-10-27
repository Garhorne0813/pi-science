/** Imperative store port. The composition root binds it after store creation,
 * so recovery/listening modules never import the React/Zustand store root. */
import type { StoreApi } from "zustand";
import type { RuntimeState } from "./types";

type RuntimeStore = Pick<StoreApi<RuntimeState>, "getState" | "setState">;
let boundStore: RuntimeStore | undefined;

function currentStore(): RuntimeStore {
  if (!boundStore) throw new Error("The runtime store has not been initialized");
  return boundStore;
}

export function bindRuntimeStore(store: RuntimeStore): void {
  // Rebinding also supports development hot reload of the composition root.
  boundStore = store;
}

export const runtimeStore: RuntimeStore = {
  get getState() { return currentStore().getState; },
  get setState() { return currentStore().setState; },
};
