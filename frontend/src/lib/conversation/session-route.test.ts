import { describe, expect, it } from "vitest";
import { conversationSessionId } from "./session-route";

describe("conversationSessionId", () => {
  it("returns the session only for a conversation route", () => {
    expect(conversationSessionId("/workspace/%2Ftmp%2Flab/session/session-1")).toBe("session-1");
    expect(conversationSessionId("/workspace/%2Ftmp%2Flab/notebooks")).toBeUndefined();
    expect(conversationSessionId("/workspace/%2Ftmp%2Flab/runs")).toBeUndefined();
  });
});
