import { describe, expect, it } from "vitest";
import { isNewConversation, replacementSessionUrl } from "./session-navigation";

describe("new conversation detection", () => {
  it("treats an empty workspace without an active session as a new conversation", () => {
    expect(isNewConversation(false, null, undefined, false)).toBe(true);
  });

  it("does not treat a conversation with a user message as new", () => {
    expect(isNewConversation(true, null, undefined, false)).toBe(false);
  });

  it("recognizes a newly created or loaded empty session", () => {
    expect(isNewConversation(false, "session-1", "New Session", false)).toBe(true);
    expect(isNewConversation(false, "session-1", "Untitled", true)).toBe(true);
  });
});

describe("session route replacement", () => {
  it("replaces only the active session suffix and preserves URL details", () => {
    expect(replacementSessionUrl(
      { pathname: "/workspace/lab/session/old%20id", search: "?panel=files", hash: "#result" },
      "old id",
      "new/id",
    )).toBe("/workspace/lab/session/new%2Fid?panel=files#result");
  });

  it("does not rewrite unrelated routes", () => {
    expect(replacementSessionUrl(
      { pathname: "/workspace/lab/files", search: "", hash: "" },
      "old",
      "new",
    )).toBeNull();
  });
});
