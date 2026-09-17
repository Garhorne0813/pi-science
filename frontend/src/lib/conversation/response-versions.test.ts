import { describe, expect, it } from "vitest";
import { bindResponseVersionMessage, responseVersionGroup, type ResponseVersionGroup } from "./response-versions";

const groups: ResponseVersionGroup[] = [{
  id: "g1",
  versions: [
    { id: "v1", sessionId: "s1", userMessageId: "u1", parentSessionId: null, forkEntryId: null, createdAt: "2026-01-01", status: "ready" },
    { id: "v2", sessionId: "s2", userMessageId: null, parentSessionId: "s1", forkEntryId: "e1", createdAt: "2026-01-02", status: "generating" },
  ],
}];

describe("response versions", () => {
  it("finds a persisted version group by exact session and user message identity", () => {
    expect(responseVersionGroup(groups, "s1", "u1")?.id).toBe("g1");
    expect(responseVersionGroup(groups, "s2", "u1")).toBeUndefined();
  });

  it("binds only the server-issued pending version id", () => {
    const bound = bindResponseVersionMessage(groups, "v2", "u2");
    expect(responseVersionGroup(bound, "s2", "u2")?.versions).toHaveLength(2);
    expect(groups[0]?.versions[1]?.userMessageId).toBeNull();
  });
});
