import { describe, expect, it } from "vitest";
import { replacementSessionUrl } from "./session-navigation";

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
