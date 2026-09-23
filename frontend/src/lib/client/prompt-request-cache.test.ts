import { describe, expect, it } from "vitest";
import {
  findLocalPromptRequest,
  promptContentDigest,
  saveLocalPromptRequest,
} from "./prompt-request-cache";
import { installClientTestEnvironment } from "./test-helpers";

installClientTestEnvironment();

describe("pending prompt request cache", () => {
  it("persists only the request identity and digest, scoped to workspace and session", async () => {
    const message = "keep this prompt out of sessionStorage";
    const contentDigest = promptContentDigest(message);
    const record = {
      cwd: "/workspace-a",
      sessionId: "session-a",
      clientMessageId: "8fd824aa-51d3-4f63-839c-09e021b7970b",
      contentDigest,
      status: "indeterminate" as const,
    };
    saveLocalPromptRequest(record);

    expect(findLocalPromptRequest("/workspace-a", "session-a", contentDigest)).toEqual(record);
    expect(findLocalPromptRequest("/workspace-b", "session-a", contentDigest)).toBeNull();
    expect(findLocalPromptRequest("/workspace-a", "session-b", contentDigest)).toBeNull();
    expect(sessionStorage.getItem("pi-science.pending-prompt-requests.v1")).not.toContain(message);
  });
});
