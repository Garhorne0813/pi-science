import { afterEach, describe, expect, it, vi } from "vitest";

import { getClient } from "../../client/pi-science-client";
import { useRuntimeStore } from "../index";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "../test-helpers";

installRuntimeTestEnvironment();
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

/** The stream envelope the server stamps on every record. */
function versioned(event: Record<string, unknown>, seq: number) {
  return { schemaVersion: 3, eventId: `epoch-1:${seq}`, seq, ...event };
}

describe("approval mode changes on a versioned stream", () => {
  it("consumes the sequence of an approval.mode.changed record instead of opening a hole", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    const client = getClient();
    const getMessagesPage = vi.spyOn(client, "getMessagesPage").mockImplementation(async () => ({
      messages: [],
      next_cursor: null,
      has_more: false,
      snapshot_version: "snapshot-1",
    }));
    vi.spyOn(client, "getSessionState").mockResolvedValue(state("session-approval"));
    vi.spyOn(client, "getTurnArtifacts").mockResolvedValue({ turns: [] });

    await useRuntimeStore.getState().connect("/workspace", "session-approval");
    const initialReads = getMessagesPage.mock.calls.length;
    const source = FakeEventSource.instances[0];
    source.open();

    const approvalEvents: unknown[] = [];
    const onApprovalChanged = (event: Event) => { approvalEvents.push((event as CustomEvent).detail); };
    window.addEventListener("pi-science-approval-mode-changed", onApprovalChanged);
    try {
      source.emit("operation.started", versioned({
        type: "operation.started", sessionId: "session-approval", turnId: "turn-1", runId: "run-1",
      }, 1), "epoch-1:1");
      source.emit("approval.mode.changed", versioned({
        type: "approval.mode.changed", sessionId: "session-approval", mode: "auto", revision: 2,
      }, 2), "epoch-1:2");
      source.emit("message.delta", versioned({
        type: "message.delta", sessionId: "session-approval", turnId: "turn-1", runId: "run-1",
        partId: "part-1", text: "after the approval switch", revision: 1,
      }, 3), "epoch-1:3");

      // The approval event still reaches the UI, exactly once.
      expect(approvalEvents).toHaveLength(1);
      expect(approvalEvents[0]).toMatchObject({ mode: "auto", revision: 2 });

      await new Promise((resolve) => setTimeout(resolve, 0));

      const foldState = useRuntimeStore.getState().thread.foldState;
      expect(foldState?.reconciliationRequired).toBeFalsy();
      expect(foldState?.lastSequence).toBe(3);
      // No sequence hole, so no authoritative rebase was started.
      expect(getMessagesPage.mock.calls.length).toBe(initialReads);
      expect(useRuntimeStore.getState().transportStatus).not.toBe("recovering");
    } finally {
      window.removeEventListener("pi-science-approval-mode-changed", onApprovalChanged);
    }
  });
});
