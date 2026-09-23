import { describe, expect, it, vi } from "vitest";
import type { HistoryMessage, PiScienceClient } from "../client/pi-science-client";
import type { ThreadBlock } from "../../types/thread";
import { attachTurnArtifacts, mergeHistoryWindow, type Thread } from "./event-fold";
import { mergeRecoveryHistoryWindow } from "./history-window-recovery";
import { buildTurnPresentations } from "../conversation/turn-presentation";

const turnId = "turn-s-2-00000000-0000-4000-8000-000000000000";
const thinking: ThreadBlock = { kind: "thinking", id: "anonymous-thinking", turnId, parts: [{ id: "p", text: "reasoning" }] };
const tool: ThreadBlock = { kind: "tool", id: "tool-call", callId: "call", tool: "write", status: "done", turnId };
const messages: HistoryMessage[] = [
  { id: "user", role: "user", client_message_id: "request", timestamp: "2026-09-23T15:49:00Z", content: [{ type: "text", text: "make SVG" }] },
  { id: "assistant", role: "assistant", content: [{ type: "toolCall", id: "call", name: "write", arguments: {} }] },
];
function thread(blocks: ThreadBlock[]): Thread {
  return { blocks, index: Object.fromEntries(blocks.map((block, index) => [block.id, index])), loaded: true };
}
function withArtifacts(current: Thread): Thread {
  return attachTurnArtifacts(current, [{
    turn_id: turnId, session_id: "s", assistant_message_id: null, turn_ordinal: 2,
    ended_at: "2026-09-23T15:52:00Z", artifacts: [{ path: "image.svg", kind: "image", mime: "image/svg+xml", size: 10 }],
  }], { windowComplete: true });
}

describe("history recovery turn fragments", () => {
  it("drops live reasoning covered by an authoritative user turn instead of keeping an older prefix", () => {
    const merged = mergeHistoryWindow(thread([thinking, tool]), messages, { keepLiveExtras: false, resetProjection: true });
    const turns = buildTurnPresentations(withArtifacts(merged.thread).blocks);
    expect(merged.retainedOlderPrefix).toBe(false);
    expect(turns).toHaveLength(1);
    expect(turns[0].user?.id).toBe("user");
    expect(turns[0].artifacts).toHaveLength(1);
    expect(merged.thread.blocks.some((block) => block.id === thinking.id)).toBe(false);
  });

  it("repairs an already fragmented complete window even after history lost runtime identities", async () => {
    const fragmented = thread([thinking,
      { kind: "artifact-summary", id: "strip", turnId, artifacts: [] },
      { kind: "user", id: "user", client_message_id: "request", text: "make SVG" },
      { ...tool, turnId: undefined },
    ]);
    const client = { getMessagesPage: vi.fn() } as unknown as PiScienceClient;
    const merged = await mergeRecoveryHistoryWindow(client, "s", "/workspace", fragmented,
      { messages, has_more: false, next_cursor: null, snapshot_version: "v1" },
      { keepLiveExtras: false, resetProjection: true });
    expect(merged.thread.blocks.map((block) => block.id)).toEqual(["user", "tool-call"]);
    expect(merged.retainedOlderPrefix).toBe(false);
    expect(buildTurnPresentations(withArtifacts(merged.thread).blocks)).toHaveLength(1);
    expect(client.getMessagesPage).not.toHaveBeenCalled();
  });

  it("keeps a genuinely older orphan turn before a partial snapshot", () => {
    const older: ThreadBlock = { ...thinking, id: "older-thinking", turnId: "older-turn" };
    const merged = mergeHistoryWindow(thread([older, thinking, tool]), messages, { keepLiveExtras: false });
    expect(merged.thread.blocks.map((block) => block.id)).toEqual(["older-thinking", "user", "tool-call"]);
    expect(merged.retainedOlderPrefix).toBe(true);
    expect(buildTurnPresentations(merged.thread.blocks)).toHaveLength(2);
  });

  it("keeps same-turn reasoning when the latest page starts after its user boundary", () => {
    const merged = mergeHistoryWindow(thread([thinking, tool]), messages.slice(1), { keepLiveExtras: false });
    expect(merged.thread.blocks.map((block) => block.id)).toEqual(["anonymous-thinking", "tool-call"]);
    expect(merged.retainedOlderPrefix).toBe(true);
  });

  it("keeps a preserved live fragment with its owner when a snapshot includes a newer turn", () => {
    const newer: HistoryMessage = { id: "next-user", role: "user", content: [{ type: "text", text: "next" }] };
    const merged = mergeHistoryWindow(thread([thinking, tool]), [...messages, newer], { keepLiveExtras: true });
    const turns = buildTurnPresentations(merged.thread.blocks);
    expect(turns).toHaveLength(2);
    expect(turns[0].blocks.map((block) => block.id)).toContain(thinking.id);
    expect(turns[1].blocks.map((block) => block.id)).not.toContain(thinking.id);
  });

  it("retains live reasoning during recovery inside the restored user turn", () => {
    const merged = mergeHistoryWindow(thread([thinking, tool]), messages, { keepLiveExtras: true });
    expect(merged.thread.blocks.some((block) => block.id === thinking.id)).toBe(true);
    const turns = buildTurnPresentations(merged.thread.blocks, { lastTurnLifecycle: "active", lastTurnId: turnId });
    expect(turns).toHaveLength(1);
    expect(turns[0].active).toBe(true);
    expect(turns[0].user?.id).toBe("user");
  });
});
