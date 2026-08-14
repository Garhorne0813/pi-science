import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useConversationNavigation } from "./useConversationNavigation";
import { queryClient } from "../lib/client/query-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/bookmarks")) return jsonResponse({ bookmarks: [], legacy_skipped: 0 });
    if (url.includes("/read-state") && init?.method !== "PUT") {
      return jsonResponse({ session_id: "s1", anchor_message_id: null, at_bottom: false, seen_snapshot_version: null, updated_at: null, anchor_available: false, before: null });
    }
    if (init?.method === "PUT") return jsonResponse({ ok: true });
    return jsonResponse({ error: `unhandled ${url}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  queryClient.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useConversationNavigation read-position writes", () => {
  it("debounces an anchor change into a single PUT read-state request", async () => {
    const fetchMock = stubFetch();
    const { result, unmount } = renderHook(() => useConversationNavigation("proj", "s1"));
    act(() => { result.current.scheduleAnchorWrite("m1"); });
    act(() => { result.current.scheduleAnchorWrite("m1"); });

    await waitFor(() => {
      const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT" && String(init?.body).includes("anchor_message_id"));
      expect(puts).toHaveLength(1);
    });
    const body = JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")?.[1]?.body ?? "{}")) as { anchor_message_id: string; at_bottom: boolean };
    expect(body.anchor_message_id).toBe("m1");
    expect(body.at_bottom).toBe(false);
    unmount();
  });

  it("cancels the pending write when the session changes", async () => {
    const fetchMock = stubFetch();
    const { result, rerender, unmount } = renderHook(
      ({ cwd, sessionId }: { cwd: string; sessionId: string | undefined }) => useConversationNavigation(cwd, sessionId),
      { initialProps: { cwd: "proj", sessionId: "s1" } },
    );
    act(() => { result.current.scheduleAnchorWrite("m1"); });
    // Switch sessions before the 400ms debounce fires.
    rerender({ cwd: "proj", sessionId: "s2" });

    await new Promise((resolve) => setTimeout(resolve, 600));
    const putsForS1 = fetchMock.mock.calls.filter(([url, init]) => init?.method === "PUT" && String(url).includes("/api/sessions/s1/read-state"));
    expect(putsForS1).toHaveLength(0);
    unmount();
  });

  it("marks seen once per snapshot and once more for a new snapshot", async () => {
    const fetchMock = stubFetch();
    const { result, unmount } = renderHook(() => useConversationNavigation("proj", "s1"));
    act(() => { result.current.scheduleMarkSeen("v1"); });
    act(() => { result.current.scheduleMarkSeen("v1"); });
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT").length).toBe(1);
    });
    act(() => { result.current.scheduleMarkSeen("v2"); });
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT").length).toBe(2);
    });
    const lastBody = JSON.parse(String(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT").at(-1)?.[1]?.body ?? "{}")) as { at_bottom: boolean; mark_seen: boolean };
    expect(lastBody.at_bottom).toBe(true);
    expect(lastBody.mark_seen).toBe(true);
    unmount();
  });

  it("interleaves anchor and seen writes without poisoning each other's dedup", async () => {
    const fetchMock = stubFetch();
    const { result, unmount } = renderHook(() => useConversationNavigation("proj", "s1"));
    const puts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");

    // Anchor scheduled; then the user returns to the bottom before the anchor
    // debounce fires. The seen write wins, and the anchor dedup ref is reset.
    act(() => { result.current.scheduleAnchorWrite("m1"); });
    act(() => { result.current.scheduleMarkSeen("v1"); });
    await waitFor(() => expect(puts().length).toBe(1));
    const first = JSON.parse(String(puts()[0]?.[1]?.body ?? "{}")) as { at_bottom?: boolean; mark_seen?: boolean };
    expect(first.at_bottom).toBe(true);
    expect(first.mark_seen).toBe(true);

    // The same anchor can be scheduled again after the seen write: its dedup
    // ref was reset when mark-seen cancelled the pending anchor write.
    act(() => { result.current.scheduleAnchorWrite("m1"); });
    await waitFor(() => expect(puts().length).toBe(2));
    const second = JSON.parse(String(puts()[1]?.[1]?.body ?? "{}")) as { anchor_message_id?: string; at_bottom?: boolean };
    expect(second.anchor_message_id).toBe("m1");
    expect(second.at_bottom).toBe(false);

    // Reverse direction: seen scheduled, then an anchor write cancels it and
    // resets the seen dedup ref, so a later mark-seen for that same snapshot
    // still fires (it was never actually written).
    act(() => { result.current.scheduleMarkSeen("v2"); });
    act(() => { result.current.scheduleAnchorWrite("m2"); });
    await waitFor(() => expect(puts().length).toBe(3));
    const third = JSON.parse(String(puts()[2]?.[1]?.body ?? "{}")) as { anchor_message_id?: string };
    expect(third.anchor_message_id).toBe("m2");
    act(() => { result.current.scheduleMarkSeen("v2"); });
    await waitFor(() => expect(puts().length).toBe(4));
    const fourth = JSON.parse(String(puts()[3]?.[1]?.body ?? "{}")) as { at_bottom?: boolean; mark_seen?: boolean };
    expect(fourth.at_bottom).toBe(true);
    expect(fourth.mark_seen).toBe(true);
    unmount();
  });

  it("never fires a debounced write after unmount", async () => {
    const fetchMock = stubFetch();
    const { result, unmount } = renderHook(() => useConversationNavigation("proj", "s1"));
    act(() => { result.current.scheduleAnchorWrite("m1"); });
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
  });

  it("ignores a second createBookmark call while the first is in flight", async () => {
    const fetchMock = stubFetch();
    const { result, unmount } = renderHook(() => useConversationNavigation("proj", "s1"));
    act(() => { result.current.createBookmark("m1"); });
    act(() => { result.current.createBookmark("m1"); });
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).includes("/api/bookmarks"));
      expect(posts).toHaveLength(1);
    });
    unmount();
  });
});

describe("useConversationNavigation proposal feedback", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  const PROPOSED = {
    session_id: "s1",
    bookmarks: [{ bookmark_id: "p1", session_id: "s1", message_id: "m1", role: "assistant", quote: "final result verified", label: null, origin: "agent_proposal", status: "proposed", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
    skipped: 0,
  };

  /** Fetch mock with a controllable propose response; all other navigation
   *  reads return empty data so invalidation refetches settle immediately. */
  function proposeFetch(proposeHandler: () => Promise<Response>): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/api/bookmarks/propose")) return proposeHandler();
      if (url.includes("/api/bookmarks")) return jsonResponse({ bookmarks: [], legacy_skipped: 0 });
      if (url.includes("/read-state")) return jsonResponse({ session_id: "s1", anchor_message_id: null, at_bottom: false, seen_snapshot_version: null, updated_at: null, anchor_available: false, before: null });
      return jsonResponse({ error: `unhandled ${url}` }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("exposes proposePending and proposeResult and ignores repeat clicks while in flight", async () => {
    const gate = deferred<Response>();
    const fetchMock = proposeFetch(() => gate.promise);
    const { result, unmount } = renderHook(() => useConversationNavigation("proj", "s1"));

    act(() => { result.current.proposeBookmarks(); });
    act(() => { result.current.proposeBookmarks(); });
    const posts = () => fetchMock.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).includes("/api/bookmarks/propose"));
    // The mutation runs mutationFn in a microtask; the repeat click must still
    // be deduplicated by the in-flight guard.
    await waitFor(() => expect(posts()).toHaveLength(1));
    await waitFor(() => expect(result.current.proposePending).toBe(true));
    expect(result.current.proposeResult).toBeNull();

    await act(async () => { gate.resolve(jsonResponse(PROPOSED)); });
    await waitFor(() => expect(result.current.proposePending).toBe(false));
    expect(result.current.proposeResult?.bookmarks).toHaveLength(1);
    expect(result.current.proposeResult?.bookmarks[0]?.status).toBe("proposed");
    expect(result.current.proposeError).toBeNull();
    unmount();
  });

  it("surfaces propose errors on proposeError instead of swallowing them", async () => {
    const fetchMock = proposeFetch(() => Promise.resolve(jsonResponse({ error: "suggestion failed" }, 500)));
    const { result, unmount } = renderHook(() => useConversationNavigation("proj", "s1"));

    act(() => { result.current.proposeBookmarks(); });
    await waitFor(() => expect(result.current.proposeError).toBeInstanceOf(Error));
    expect(result.current.proposeError?.message).toContain("suggestion failed");
    expect(result.current.proposePending).toBe(false);
    expect(result.current.proposeResult).toBeNull();
    // A later run is not blocked by the failed one.
    fetchMock.mockClear();
    act(() => { result.current.proposeBookmarks(); });
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).includes("/api/bookmarks/propose")).length).toBe(1);
    });
    unmount();
  });

  it("clears proposal feedback when the session changes", async () => {
    proposeFetch(() => Promise.resolve(jsonResponse(PROPOSED)));
    const { result, rerender, unmount } = renderHook(
      ({ cwd, sessionId }: { cwd: string; sessionId: string | undefined }) => useConversationNavigation(cwd, sessionId),
      { initialProps: { cwd: "proj", sessionId: "s1" } },
    );
    act(() => { result.current.proposeBookmarks(); });
    await waitFor(() => expect(result.current.proposeResult?.bookmarks).toHaveLength(1));

    rerender({ cwd: "proj", sessionId: "s2" });
    await waitFor(() => expect(result.current.proposeResult).toBeNull());
    expect(result.current.proposeError).toBeNull();
    expect(result.current.proposePending).toBe(false);
    unmount();
  });
});
