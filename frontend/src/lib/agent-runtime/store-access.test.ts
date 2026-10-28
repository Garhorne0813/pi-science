import { afterEach, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { useRuntimeStore } from "./index";
import { bindRuntimeStore } from "./store-access";
import { markWorkspaceFilesChanged } from "./file-revision";
import { generations } from "./generations";
import { workspaceFiles } from "../workspace";
import type { RuntimeState } from "./types";

afterEach(() => {
  bindRuntimeStore(useRuntimeStore);
  vi.restoreAllMocks();
});

it("routes existing imperative effects to the current store after root rebinding", () => {
  vi.spyOn(workspaceFiles, "invalidate").mockImplementation(() => undefined);
  const initial = useRuntimeStore.getInitialState();
  const first = createStore<RuntimeState>(() => ({ ...initial, activeSessionId: "first", fileRevision: 3 }));
  const replacement = createStore<RuntimeState>(() => ({ ...initial, activeSessionId: "replacement", fileRevision: 20 }));

  bindRuntimeStore(first);
  ++generations.activity;
  markWorkspaceFilesChanged();
  expect(first.getState().fileRevision).toBe(4);
  expect(replacement.getState().fileRevision).toBe(20);

  // An already-imported effect must follow a replacement composition root,
  // rather than retaining the store it first saw (for example after HMR).
  bindRuntimeStore(replacement);
  ++generations.activity;
  markWorkspaceFilesChanged();
  expect(first.getState().fileRevision).toBe(4);
  expect(replacement.getState().fileRevision).toBe(21);
});
