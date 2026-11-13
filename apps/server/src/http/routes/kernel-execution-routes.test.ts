import { describe, expect, it } from "vitest";
import { executeCellRequestSchema } from "./kernel-execution-routes.js";

describe("executeCellRequestSchema source", () => {
  it("accepts chat runs recorded from the conversation", () => {
    const parsed = executeCellRequestSchema.parse({
      language: "python",
      code: "print(1)",
      source: "chat",
      session_id: "s1",
      cell_id: "chat:fence-0",
    });
    expect(parsed.source).toBe("chat");
  });

  it("still rejects sources outside the whitelist", () => {
    expect(
      executeCellRequestSchema.safeParse({
        language: "python",
        code: "print(1)",
        source: "conversation",
      }).success,
    ).toBe(false);
  });
});
