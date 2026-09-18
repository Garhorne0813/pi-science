import { describe, expect, it } from "vitest";
import { bindResponseVersionMessage, preferredResponseVersionSession, responseVersionGroup, responseVersionRootSession, type ResponseVersionGroup } from "./response-versions";

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

  it("resolves the persisted selection and falls back to the newest version", () => {
    expect(preferredResponseVersionSession([{ ...groups[0]!, selectedVersionId: "v1" }], "s1")).toBe("s1");
    expect(preferredResponseVersionSession(groups, "s1")).toBe("s2");
    expect(preferredResponseVersionSession(groups, "unrelated")).toBe("unrelated");
  });

  it("resolves nested selected branches transitively and maps them to the visible root", () => {
    const nested: ResponseVersionGroup[] = [
      { ...groups[0]!, rootSessionId: "s1", sourceSessionId: "s1", selectedVersionId: "v2", updatedAt: "2026-01-02" },
      {
        id: "g2", rootSessionId: "s1", sourceSessionId: "s2", sourceUserMessageId: "u3", selectedVersionId: "v3", updatedAt: "2026-01-03",
        versions: [
          { id: "v2-base", sessionId: "s2", userMessageId: "u3", parentSessionId: null, forkEntryId: null, createdAt: "2026-01-02", status: "ready" },
          { id: "v3", sessionId: "s3", userMessageId: "u4", parentSessionId: "s2", forkEntryId: "e2", createdAt: "2026-01-03", status: "ready" },
        ],
      },
    ];
    expect(preferredResponseVersionSession(nested, "s1")).toBe("s3");
    expect(responseVersionRootSession(nested, "s3")).toBe("s1");
  });

  it("never resolves navigation into a failed response version", () => {
    const failed = [{
      ...groups[0]!,
      sourceSessionId: "s1",
      selectedVersionId: "v2",
      versions: groups[0]!.versions.map((version) => version.id === "v2" ? { ...version, status: "failed" as const } : version),
    }];
    expect(preferredResponseVersionSession(failed, "s1")).toBe("s1");
  });
});
