import { afterEach, describe, expect, it, vi } from "vitest";

import { useRuntimeStore } from "./index";
import { jsonResponse, installRuntimeTestEnvironment } from "./test-helpers";
import { loadMoreSessionsInternal, loadSessionsInternal } from "./sessions";

installRuntimeTestEnvironment();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadSessionsInternal stale protection", () => {
  it("appends cursor pages without truncating older sessions", async () => {
    useRuntimeStore.setState({ cwd: "/workspace", activeSessionId: null, sessions: [], sessionsCursor: null, sessionsHasMore: false, sessionsLoading: false });
    const first = Array.from({ length: 30 }, (_, index) => ({ id: `s-${index}`, cwd: "/workspace" }));
    const second = Array.from({ length: 25 }, (_, index) => ({ id: `s-${index + 30}`, cwd: "/workspace" }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("cursor=next-page")) return jsonResponse({ sessions: second, next_cursor: null, has_more: false });
      if (url.startsWith("/api/sessions?")) return jsonResponse({ sessions: first, next_cursor: "next-page", has_more: true });
      throw new Error(`Unexpected request: ${url}`);
    }));

    await loadSessionsInternal();
    await expect(loadMoreSessionsInternal()).resolves.toBe(25);

    expect(useRuntimeStore.getState().sessions).toHaveLength(55);
    expect(useRuntimeStore.getState().sessions.at(-1)?.id).toBe("s-54");
    expect(useRuntimeStore.getState().sessionsHasMore).toBe(false);
  });

  it("does not let a stale in-flight list overwrite a fresher one that resolved later", async () => {
    useRuntimeStore.setState({ cwd: "/workspace", activeSessionId: null, sessions: [] });
    const releaseStale: Array<() => void> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions?")) {
        if (releaseStale.length === 0) {
          // First (older) request: held open, resolves last with stale data.
          return new Promise<Response>((resolve) => {
            releaseStale.push(() => resolve(jsonResponse([{ id: "stale-session", cwd: "/workspace", created_at: "2026-01-01T00:00:00Z" }])));
          });
        }
        // Second (newer) request: resolves first with fresher data.
        return jsonResponse([{ id: "fresh-session", cwd: "/workspace", created_at: "2026-01-01T00:00:00Z" }]);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const stale = loadSessionsInternal();
    const fresh = await loadSessionsInternal();
    expect(fresh.map((session) => session.id)).toEqual(["fresh-session"]);
    expect(useRuntimeStore.getState().sessions.map((session) => session.id)).toEqual(["fresh-session"]);

    releaseStale[0]?.(); // stale response arrives after the fresh one
    await stale;

    expect(useRuntimeStore.getState().sessions.map((session) => session.id)).toEqual(["fresh-session"]);
    expect(useRuntimeStore.getState().sessions.some((session) => session.id === "stale-session")).toBe(false);
  });

  it("returns the current authoritative list from a stale completion instead of an empty one", async () => {
    useRuntimeStore.setState({ cwd: "/workspace", activeSessionId: null, sessions: [] });
    const releaseStale: Array<() => void> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions?")) {
        if (releaseStale.length === 0) {
          return new Promise<Response>((resolve) => {
            releaseStale.push(() => resolve(jsonResponse([{ id: "old", cwd: "/workspace", created_at: "2026-01-01T00:00:00Z" }])));
          });
        }
        return jsonResponse([{ id: "kept", cwd: "/workspace", created_at: "2026-01-01T00:00:00Z" }]);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const stale = loadSessionsInternal();
    await loadSessionsInternal();
    releaseStale[0]?.();
    // The stale promise resolves with the current list (what the caller would
    // drive navigation from), never an empty array.
    await expect(stale).resolves.toMatchObject([{ id: "kept" }]);
    expect(useRuntimeStore.getState().sessions.map((session) => session.id)).toEqual(["kept"]);
  });
});
