import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadBlock } from "../../types/thread";
import { getClient } from "../client/pi-science-client";
import { foldEvent } from "./folding/reducer";
import { useRuntimeStore } from "./index";
import * as settledHistory from "./recovery/settled-history";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";

installRuntimeTestEnvironment();
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

type ErrorRow = Extract<ThreadBlock, { kind: "status-line" }>;

function errorRows(blocks: ThreadBlock[]): ErrorRow[] {
  return blocks.filter((block): block is ErrorRow => block.kind === "status-line" && block.level === "error");
}

const answeredPage = {
  messages: [{ id: "assistant-1", role: "assistant" as const, content: [{ type: "text" as const, text: "Recovered answer from the durable transcript" }] }],
  next_cursor: null,
  has_more: false,
  snapshot_version: "snapshot-recovered",
};

/** Connect, open the stream and answer the REST reads a turn needs. */
async function startTurn() {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
  const client = getClient();
  vi.spyOn(client, "getSessionState").mockResolvedValue(state("session-recovery"));
  vi.spyOn(client, "getTurnArtifacts").mockResolvedValue({ turns: [] });
  await useRuntimeStore.getState().connect("/workspace", "session-recovery");
  const source = FakeEventSource.instances[0];
  source.open();
  source.emit("operation.started", {
    type: "operation.started",
    sessionId: "session-recovery",
    turnId: "turn-1",
    runId: "run-1",
  });
  return { client, source };
}

describe("lifecycle recovery after a terminal worker error", () => {
  it("re-reads the persisted conversation once, so an exhausted recovery still shows its answer", async () => {
    let persisted: typeof answeredPage.messages = [];
    vi.spyOn(getClient(), "getMessagesPage").mockImplementation(async () => ({
      messages: persisted,
      next_cursor: null,
      has_more: false,
      snapshot_version: "snapshot-live",
    }));
    const { source } = await startTurn();
    expect(useRuntimeStore.getState()).toMatchObject({ working: true, turnLifecycle: "active" });

    // The worker died before it could persist and publish operation.settled:
    // supervision publishes this terminal error in its place, with no turnId.
    persisted = answeredPage.messages;
    source.emit("error", {
      type: "error",
      sessionId: "session-recovery",
      code: "worker_recovery_failed",
      terminal: true,
      message: "Agent worker recovery exhausted",
    });

    expect(useRuntimeStore.getState().turnLifecycle).toBe("failed");
    expect(useRuntimeStore.getState().working).toBe(false);

    // The answer is durable even though no settled event will ever arrive.
    await vi.waitFor(() => {
      const blocks = useRuntimeStore.getState().thread.blocks;
      expect(blocks.some((block) => block.kind === "agent")).toBe(true);
    });
    const assistantText = useRuntimeStore.getState().thread.blocks
      .flatMap((block) => (block.kind === "agent" ? block.parts.map((part) => part.text) : []))
      .join("");
    expect(assistantText).toContain("Recovered answer from the durable transcript");
    // A recovery failure is still a failure: the added re-read must not
    // promote the turn to settled.
    expect(useRuntimeStore.getState().turnLifecycle).toBe("failed");
  });

  it("re-reads once when recoverable retry failures precede the terminal attempt", async () => {
    // supervision retries while an attempt remains and marks only the last
    // failure terminal (supervision.ts:79). The earlier ones must not end the
    // turn, or the final failure and the settled event a successful retry
    // produces are both swallowed by the failed-state guard.
    let persisted: typeof answeredPage.messages = [];
    vi.spyOn(getClient(), "getMessagesPage").mockImplementation(async () => ({
      messages: persisted,
      next_cursor: null,
      has_more: false,
      snapshot_version: "snapshot-live",
    }));
    const resync = vi.spyOn(settledHistory, "resyncCompletedHistory");
    const { source } = await startTurn();

    for (const event of [
      { type: "error", sessionId: "session-recovery", code: "worker_recovering", recoverable: true,
        message: "The agent worker stopped responding; restoring its durable operation." },
      { type: "error", sessionId: "session-recovery", code: "worker_recovery_failed", recoverable: true, terminal: false,
        message: "worker failed to start" },
      { type: "error", sessionId: "session-recovery", code: "worker_recovering", recoverable: true,
        message: "The agent worker stopped responding; restoring its durable operation." },
    ]) {
      source.emit("error", event);
    }
    expect(useRuntimeStore.getState()).toMatchObject({ working: true, turnLifecycle: "recovering" });
    expect(resync).not.toHaveBeenCalled();

    persisted = answeredPage.messages;
    source.emit("error", {
      type: "error",
      sessionId: "session-recovery",
      code: "worker_recovery_failed",
      terminal: true,
      message: "Agent worker recovery exhausted",
    });

    expect(useRuntimeStore.getState()).toMatchObject({ working: false, turnLifecycle: "failed" });
    await vi.waitFor(() => {
      const blocks = useRuntimeStore.getState().thread.blocks;
      expect(blocks.some((block) => block.kind === "agent")).toBe(true);
      expect(blocks.some((block) => block.kind === "status-line"
        && block.level === "error"
        && block.text === "Agent worker recovery exhausted")).toBe(true);
    });
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it("does not re-read history for a non-terminal error, whose settled event still arrives", async () => {
    vi.spyOn(getClient(), "getMessagesPage").mockResolvedValue({
      messages: [],
      next_cursor: null,
      has_more: false,
      snapshot_version: "snapshot-live",
    });
    const resync = vi.spyOn(settledHistory, "resyncCompletedHistory");
    const { source } = await startTurn();

    // A model/runtime error ends the turn as failed, but recovery is not
    // exhausted: supervision keeps the worker and operation.settled still
    // follows. Re-reading here would replace the thread before that settle
    // gets the chance to preserve the error row and the in-flight partial.
    source.emit("error", {
      type: "error",
      sessionId: "session-recovery",
      code: "model_error",
      recoverable: false,
      message: "The model call failed",
    });

    expect(useRuntimeStore.getState().turnLifecycle).toBe("failed");
    expect(resync).not.toHaveBeenCalled();
  });

  it("keeps the error row on screen when the terminal re-read replaces the thread", async () => {
    // The connect resolves the empty history first, so the assistant block in
    // the assertions below can only come from the recovery re-read.
    let persisted: typeof answeredPage.messages = [];
    vi.spyOn(getClient(), "getMessagesPage").mockImplementation(async () => ({
      messages: persisted,
      next_cursor: null,
      has_more: false,
      snapshot_version: "snapshot-live",
    }));
    const resync = vi.spyOn(settledHistory, "resyncCompletedHistory");
    const { source } = await startTurn();

    persisted = answeredPage.messages;
    source.emit("error", {
      type: "error",
      sessionId: "session-recovery",
      code: "worker_recovery_failed",
      terminal: true,
      message: "Agent worker recovery exhausted",
    });

    await vi.waitFor(() => {
      const blocks = useRuntimeStore.getState().thread.blocks;
      expect(blocks.some((block) => block.kind === "agent")).toBe(true);
    });
    // The spy must really intercept the call, otherwise the count above is
    // meaningless.
    expect(resync).toHaveBeenCalled();
    const blocks = useRuntimeStore.getState().thread.blocks;
    expect(blocks.some((block) => block.kind === "status-line"
      && block.level === "error"
      && block.text === "Agent worker recovery exhausted")).toBe(true);
    expect(useRuntimeStore.getState().turnLifecycle).toBe("failed");
  });

  it("keeps error block ids unique when another error follows the restored row", async () => {
    // The recovery re-read drops the fold state, so the restored row must take
    // its serial number from the block ids that survived: a later fold that
    // starts from a fresh fold state would otherwise mint the same id again.
    let persisted: typeof answeredPage.messages = [];
    vi.spyOn(getClient(), "getMessagesPage").mockImplementation(async () => ({
      messages: persisted,
      next_cursor: null,
      has_more: false,
      snapshot_version: "snapshot-live",
    }));
    const { source } = await startTurn();

    persisted = answeredPage.messages;
    source.emit("error", {
      type: "error",
      sessionId: "session-recovery",
      code: "worker_recovery_failed",
      terminal: true,
      message: "Agent worker recovery exhausted",
    });
    await vi.waitFor(() => {
      const blocks = useRuntimeStore.getState().thread.blocks;
      expect(blocks.some((block) => block.kind === "agent")).toBe(true);
      expect(blocks.some((block) => block.kind === "status-line" && block.level === "error")).toBe(true);
    });

    // The terminal record closed the stream (the transport drops later
    // records from the old source), so the next error is folded directly:
    // the invariant under test is the thread state, not the socket.
    const current = useRuntimeStore.getState().thread;
    const next = foldEvent(current, {
      type: "error",
      sessionId: "session-recovery",
      code: "model_error",
      recoverable: false,
      message: "The model call failed afterwards",
    });
    useRuntimeStore.setState({ thread: next });

    const rows = errorRows(next.blocks);
    expect(rows.map((block) => block.text)).toContain("The model call failed afterwards");
    expect(rows.length).toBe(2);
    const ids = rows.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("re-adds the row when an older turn closed with the same message", async () => {
    // A partial-overlap recovery keeps the blocks that precede the loaded
    // window, so an older turn's identical error row can still be on screen
    // while the current turn's row is gone. Matching by text would mistake it
    // for the row this turn still owes the user.
    vi.spyOn(getClient(), "getMessagesPage").mockResolvedValue({
      messages: [],
      next_cursor: null,
      has_more: false,
      snapshot_version: "snapshot-live",
    });
    await startTurn();
    const olderRow = {
      kind: "status-line" as const,
      id: "error-0",
      turnId: "turn-0",
      text: "Agent worker recovery exhausted",
      level: "error" as const,
    };
    // The merge that keeps the older prefix replaces everything after it — the
    // row this turn folded for the same text included.
    vi.spyOn(settledHistory, "resyncCompletedHistory").mockImplementation(async () => {
      // Let the fold of the error record land first, then replace the window
      // while dropping this turn's row: that is the merge's real end state.
      await Promise.resolve();
      useRuntimeStore.setState({
        thread: { blocks: [olderRow], index: { [olderRow.id]: 0 }, loaded: true },
      });
    });

    FakeEventSource.instances[0].emit("error", {
      type: "error",
      sessionId: "session-recovery",
      code: "worker_recovery_failed",
      terminal: true,
      message: "Agent worker recovery exhausted",
    });

    await vi.waitFor(() => {
      expect(errorRows(useRuntimeStore.getState().thread.blocks).length).toBe(2);
    });
    const rows = errorRows(useRuntimeStore.getState().thread.blocks);
    expect(rows.map((block) => block.turnId)).toEqual(["turn-0", "turn-1"]);
    expect(new Set(rows.map((block) => block.id)).size).toBe(2);
  });
});
