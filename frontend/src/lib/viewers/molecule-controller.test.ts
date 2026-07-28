import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeMoleculeViewerCommand,
  getActiveMoleculeViewer,
  registerActiveMoleculeViewer,
  subscribeActiveMoleculeViewer,
} from "./molecule-controller";

afterEach(() => {
  const active = getActiveMoleculeViewer();
  if (active) {
    registerActiveMoleculeViewer({
      id: `cleanup:${active.id}`,
      filename: "cleanup",
      execute: async () => undefined,
    })();
  }
});

describe("active molecule viewer controller", () => {
  it("registers, executes, observes, and unregisters the active viewer", async () => {
    const execute = vi.fn(async (command: string) => ({ command }));
    const updates: Array<string | null> = [];
    const unsubscribe = subscribeActiveMoleculeViewer((controller) => {
      updates.push(controller?.id ?? null);
    });
    const unregister = registerActiveMoleculeViewer({
      id: "patinae:protein",
      filename: "protein.pdb",
      execute,
    });

    await expect(executeMoleculeViewerCommand("orient")).resolves.toEqual({ command: "orient" });
    expect(execute).toHaveBeenCalledWith("orient");
    expect(getActiveMoleculeViewer()?.filename).toBe("protein.pdb");

    unregister();
    expect(getActiveMoleculeViewer()).toBeNull();
    expect(updates).toEqual([null, "patinae:protein", null]);
    unsubscribe();
  });

  it("fails clearly when no Patinae viewer is active", async () => {
    await expect(executeMoleculeViewerCommand("orient")).rejects.toThrow("No active molecule viewer");
  });
});
