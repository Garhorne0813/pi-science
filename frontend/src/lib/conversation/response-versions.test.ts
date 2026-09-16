import { beforeEach, describe, expect, it } from "vitest";
import {
  appendResponseVersion,
  bindResponseVersionMessage,
  readResponseVersionGroups,
  responseVersionGroup,
  writeResponseVersionGroups,
} from "./response-versions";

describe("response versions", () => {
  beforeEach(() => localStorage.clear());

  it("creates a group and appends regeneration branches from any version", () => {
    const first = appendResponseVersion([],
      { sessionId: "s1", userMessageId: "u1", message: "question" },
      { sessionId: "s2", userMessageId: null, message: "question" },
    );
    const bound = bindResponseVersionMessage(first, "s2", "u2", "question");
    const second = appendResponseVersion(bound,
      { sessionId: "s2", userMessageId: "u2", message: "question" },
      { sessionId: "s3", userMessageId: null, message: "edited question" },
    );
    expect(second).toHaveLength(1);
    expect(second[0]?.versions.map((version) => version.sessionId)).toEqual(["s1", "s2", "s3"]);
  });

  it("binds a pending branch to its persisted user message", () => {
    const groups = appendResponseVersion([],
      { sessionId: "s1", userMessageId: "u1", message: "question" },
      { sessionId: "s2", userMessageId: null, message: "edited" },
    );
    const bound = bindResponseVersionMessage(groups, "s2", "u2", "edited");
    expect(responseVersionGroup(bound, "s2", "u2")?.versions).toHaveLength(2);
  });

  it("round-trips valid groups through workspace-scoped storage", () => {
    const groups = appendResponseVersion([],
      { sessionId: "s1", userMessageId: "u1", message: "question" },
      { sessionId: "s2", userMessageId: null, message: "question" },
    );
    writeResponseVersionGroups("/workspace", groups);
    expect(readResponseVersionGroups("/workspace")).toEqual(groups);
    expect(readResponseVersionGroups("/other")).toEqual([]);
  });
});
