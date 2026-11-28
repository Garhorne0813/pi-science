import { describe, expect, it } from "vitest";
import {
  findLocalPromptRequest,
  localPromptRequests,
  pendingPromptRequests,
  promptContentDigest,
  removeLocalPromptRequest,
  saveLocalPromptRequest,
  updateLocalPromptRequest,
} from "./prompt-request-cache";
import { installClientTestEnvironment } from "./test-helpers";

installClientTestEnvironment();

const V2_KEY = "pi-science.pending-prompt-requests.v2";

function record(overrides: Partial<Parameters<typeof saveLocalPromptRequest>[0]> = {}) {
  const text = overrides.text ?? "draw the curve";
  return {
    cwd: "/workspace-a",
    sessionId: "session-a",
    clientMessageId: "8fd824aa-51d3-4f63-839c-09e021b7970b",
    contentDigest: promptContentDigest(text),
    text,
    createdAt: 1_760_000_000_000,
    status: "pending" as const,
    ...overrides,
  };
}

describe("pending prompt request cache", () => {
  it("persists the text in localStorage and keeps lookups scoped to workspace and session", () => {
    const saved = record();
    saveLocalPromptRequest(saved);

    expect(findLocalPromptRequest("/workspace-a", "session-a", saved.contentDigest)).toEqual(saved);
    expect(findLocalPromptRequest("/workspace-b", "session-a", saved.contentDigest)).toBeNull();
    expect(findLocalPromptRequest("/workspace-a", "session-b", saved.contentDigest)).toBeNull();
    // The whole point of v2: the text survives a reload.
    expect(localStorage.getItem(V2_KEY)).toContain(saved.text);
  });

  it("drops malformed payloads instead of trusting them", () => {
    localStorage.setItem(V2_KEY, JSON.stringify([
      { cwd: "/workspace-a", sessionId: "s", clientMessageId: "no-version", contentDigest: "d", text: "x", createdAt: 1, status: "pending" },
      { schemaVersion: 2, cwd: "/workspace-a", sessionId: "s", clientMessageId: "bad-status", contentDigest: "d", text: "x", createdAt: 1, status: "done" },
      { schemaVersion: 2, cwd: "/workspace-a", sessionId: "s", clientMessageId: "kept", contentDigest: "d", text: "x", createdAt: 1, status: "pending" },
    ]));

    expect(localPromptRequests("/workspace-a", "s").map((item) => item.clientMessageId)).toEqual(["kept"]);
  });

  it("keeps the original creation time when a replay re-saves the same record", () => {
    const saved = record();
    saveLocalPromptRequest(saved);
    saveLocalPromptRequest({ ...saved, sessionId: "session-b", createdAt: saved.createdAt + 60_000 });

    expect(findLocalPromptRequest("/workspace-a", "session-b", saved.contentDigest)?.createdAt).toBe(saved.createdAt);
  });

  it("lists unfinished requests for a workspace, including one with no session yet", () => {
    saveLocalPromptRequest(record({ clientMessageId: "blank", sessionId: "" }));
    saveLocalPromptRequest(record({ clientMessageId: "other", cwd: "/workspace-b" }));
    saveLocalPromptRequest(record({ clientMessageId: "landed" }));

    expect(pendingPromptRequests("/workspace-a").map((item) => item.clientMessageId)).toEqual(["blank", "landed"]);

    updateLocalPromptRequest("landed", { status: "persisted" });
    expect(pendingPromptRequests("/workspace-a").map((item) => item.clientMessageId)).toEqual(["blank"]);

    removeLocalPromptRequest("blank");
    expect(pendingPromptRequests("/workspace-a")).toEqual([]);
  });
});
