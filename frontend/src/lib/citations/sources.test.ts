import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../client/query-client";
import { useCitationSources } from "./sources";

const requested: string[] = [];

function stubFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return new Response(JSON.stringify({ sessionId: "session-1", sources: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

afterEach(() => { cleanup(); queryClient.clear(); requested.length = 0; vi.unstubAllGlobals(); });

describe("useCitationSources", () => {
  it("asks for the turns the answer belongs to", async () => {
    stubFetch();
    renderHook(() => useCitationSources("/tmp/lab", "session-1", ["turn-1"]));
    await waitFor(() => expect(requested).toHaveLength(1));
    expect(requested[0]).toContain("turnId=turn-1");
  });

  it("asks for nothing when the answer has no turn id", async () => {
    stubFetch();
    const { result } = renderHook(() => useCitationSources("/tmp/lab", "session-1", []));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requested).toEqual([]);
    expect(result.current).toEqual([]);
  });
});
