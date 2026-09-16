import { describe, expect, it, vi } from "vitest";
import type { HistoryMessage, PiScienceClient, SessionMessagePage } from "../client/pi-science-client";
import { threadFromMessages } from "./event-fold";
import { mergeRecoveryHistoryWindow } from "./history-window-recovery";

function messages(ids: string[]): HistoryMessage[] {
  return ids.map((id) => ({ id, role: "user", content: [{ type: "text", text: id }] }));
}

function page(ids: string[], nextCursor: string | null, hasMore: boolean): SessionMessagePage {
  return { messages: messages(ids), next_cursor: nextCursor, has_more: hasMore, snapshot_version: "snapshot-1" };
}

describe("recovery history window", () => {
  it("walks older pages until a moved latest window overlaps loaded history", async () => {
    const current = threadFromMessages(messages(["m1", "m2"]));
    const getMessagesPage = vi.fn(async (_sessionId: string, _cwd?: string, options?: { before?: string | null }) => {
      expect(options?.before).toBe("cursor-1");
      return page(["m2", "m3", "m4"], "cursor-2", true);
    });
    const client = { getMessagesPage } as unknown as PiScienceClient;

    const merged = await mergeRecoveryHistoryWindow(
      client,
      "session-a",
      "/workspace",
      current,
      page(["m5", "m6"], "cursor-1", true),
      { keepLiveExtras: false },
    );

    expect(getMessagesPage).toHaveBeenCalledTimes(1);
    expect(merged.retainedOlderPrefix).toBe(true);
    expect(merged.thread.blocks.map((block) => block.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
  });

  it("replaces the window only after reaching the beginning with no overlap", async () => {
    const current = threadFromMessages(messages(["old-1", "old-2"]));
    const client = {
      getMessagesPage: vi.fn(async () => page(["new-1", "new-2"], null, false)),
    } as unknown as PiScienceClient;

    const merged = await mergeRecoveryHistoryWindow(
      client,
      "session-a",
      "/workspace",
      current,
      page(["new-3", "new-4"], "cursor-1", true),
      { keepLiveExtras: false },
    );

    expect(merged.retainedOlderPrefix).toBe(false);
    expect(merged.thread.blocks.map((block) => block.id)).toEqual(["new-1", "new-2", "new-3", "new-4"]);
    expect(merged.boundaryPage.has_more).toBe(false);
  });

  it("keeps loaded history when an overlap probe fails", async () => {
    const current = threadFromMessages(messages(["m1", "m2"]));
    const client = {
      getMessagesPage: vi.fn(async () => { throw new Error("offline"); }),
    } as unknown as PiScienceClient;

    const merged = await mergeRecoveryHistoryWindow(
      client,
      "session-a",
      "/workspace",
      current,
      page(["m5", "m6"], "cursor-1", true),
      { keepLiveExtras: false },
    );

    expect(merged.retainedOlderPrefix).toBe(true);
    expect(merged.thread).toBe(current);
  });
});
