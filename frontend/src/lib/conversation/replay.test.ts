import { describe, expect, it } from "vitest";

import type { UserMessageBlock } from "../../types/thread";
import { replayForkEntryId } from "./replay";

describe("replay fork point", () => {
  it("uses the user entry rather than its persisted parent", () => {
    const block: UserMessageBlock = { kind: "user", id: "u2", parentId: "model-change-1", text: "again" };
    expect(replayForkEntryId(block)).toBe("u2");
  });

  it("uses the selected user entry when parent metadata is unavailable", () => {
    const block: UserMessageBlock = { kind: "user", id: "u2", text: "again" };
    expect(replayForkEntryId(block)).toBe("u2");
  });

  it("lets Pi Orbit fork before the first user message", () => {
    const block: UserMessageBlock = { kind: "user", id: "u1", parentId: "model-change-1", text: "first" };
    expect(replayForkEntryId(block)).toBe("u1");
  });
});
