import { describe, expect, it } from "vitest";
import {
  findLocalPromptRequest,
  localPromptRequests,
  pendingPromptRequests,
  promptContentDigest,
  saveLocalPromptRequest,
} from "./prompt-request-cache";
import { installClientTestEnvironment } from "./test-helpers";

installClientTestEnvironment();

const KEY = "pi-science.pending-prompt-requests.v2";
const LEGACY_KEY = "pi-science.pending-prompt-requests.v1";

function record(overrides: Partial<Parameters<typeof saveLocalPromptRequest>[0]> = {}) {
  const text = overrides.text ?? "replay me after the refresh";
  return {
    cwd: "/workspace-a",
    sessionId: "",
    clientMessageId: "8fd824aa-51d3-4f63-839c-09e021b7970b",
    contentDigest: promptContentDigest(text),
    text,
    createdAt: 1_700_000_000_000,
    status: "pending" as const,
    ...overrides,
  };
}

describe("pending prompt request cache", () => {
  it("round-trips the prompt text so a reload can replay it", () => {
    const saved = record();
    saveLocalPromptRequest(saved);

    expect(findLocalPromptRequest("/workspace-a", "", saved.contentDigest)).toEqual(saved);
    // localStorage, not sessionStorage: closing the tab must not lose it.
    expect(localStorage.getItem(KEY)).toContain(saved.text);
  });

  it("keeps the request scoped to its workspace and session", () => {
    const saved = record({ sessionId: "" });
    saveLocalPromptRequest(saved);

    expect(findLocalPromptRequest("/workspace-b", "", saved.contentDigest)).toBeNull();
    expect(findLocalPromptRequest("/workspace-a", "session-b", saved.contentDigest)).toBeNull();
    expect(localPromptRequests("/workspace-a", "")).toEqual([saved]);
    expect(pendingPromptRequests("/workspace-a")).toEqual([saved]);
    expect(pendingPromptRequests("/workspace-b")).toEqual([]);
  });

  it("drops a payload written by the old schema instead of replaying it", () => {
    // v1 lived in sessionStorage and carried no text at all.
    sessionStorage.setItem(LEGACY_KEY, JSON.stringify([{
      cwd: "/workspace-a",
      sessionId: "",
      clientMessageId: "legacy-id",
      contentDigest: "abc",
      status: "pending",
    }]));
    // A damaged v2 payload is dropped for the same reason: no version stamp.
    localStorage.setItem(KEY, JSON.stringify([{
      cwd: "/workspace-a",
      sessionId: "",
      clientMessageId: "unstamped-id",
      contentDigest: "abc",
      text: "must not be replayed",
      createdAt: 1,
      status: "pending",
    }]));

    expect(pendingPromptRequests("/workspace-a")).toEqual([]);
    expect(sessionStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("ignores malformed JSON without throwing", () => {
    localStorage.setItem(KEY, "{not json");
    expect(pendingPromptRequests("/workspace-a")).toEqual([]);
  });

  it("keeps the original creation time when a replay re-saves the record", () => {
    const saved = record();
    saveLocalPromptRequest(saved);
    saveLocalPromptRequest({ ...saved, createdAt: saved.createdAt + 60_000 });

    expect(pendingPromptRequests("/workspace-a")[0]?.createdAt).toBe(saved.createdAt);
  });
});
