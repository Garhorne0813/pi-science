import { describe, expect, it, vi } from "vitest";
import type { TurnPresentation } from "../../lib/conversation/turn-presentation";
import { conversationTurnItemKey, renderConversationTurnSlot } from "./LiveSessionPage";

describe("LiveSessionPage Virtuoso stale-slot guards", () => {
  it("returns a deterministic fallback key for a missing item", () => {
    expect(conversationTurnItemKey(7, undefined)).toBe("__stale-turn:7");
  });

  it("preserves the real turn id for normal items", () => {
    const turn = { id: "turn-x" } as TurnPresentation;
    expect(conversationTurnItemKey(3, turn)).toBe("turn-x");
  });

  it("skips rendering a missing item", () => {
    const render = vi.fn(() => "rendered");
    expect(renderConversationTurnSlot(undefined, render)).toBeNull();
    expect(render).not.toHaveBeenCalled();
  });

  it("renders normal items unchanged", () => {
    const turn = { id: "turn-x" } as TurnPresentation;
    const render = vi.fn(() => "rendered");
    expect(renderConversationTurnSlot(turn, render)).toBe("rendered");
    expect(render).toHaveBeenCalledWith(turn);
  });
});
