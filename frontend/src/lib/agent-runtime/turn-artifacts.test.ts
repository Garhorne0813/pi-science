import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "../client/pi-science-client";
import { queryClient } from "../client/query-client";
import { attachPersistedTurnArtifacts } from "./turn-artifacts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("persisted turn artifacts", () => {
  beforeEach(() => {
    queryClient.clear();
    createClient("");
  });

  afterEach(() => {
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it("shares the artifact list across repeated refresh restores", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ turns: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const thread = { blocks: [], index: {}, loaded: true };
    await attachPersistedTurnArtifacts(thread, "session-a", "/workspace");
    await attachPersistedTurnArtifacts(thread, "session-a", "/workspace");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/sessions/session-a/artifacts?cwd=%2Fworkspace");
  });
});
