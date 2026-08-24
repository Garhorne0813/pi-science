import { describe, expect, it, vi } from "vitest";

import { PiScienceClient } from "./pi-science-client";
import { REQUEST_TIMEOUT_MS, SESSION_CREATION_TIMEOUT_MS } from "./http";
import { installClientTestEnvironment } from "./test-helpers";


installClientTestEnvironment();


describe("PiScienceClient REST calls", () => {
  it("inherits backend model settings when creating a session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "session-luna",
      cwd: "/workspace",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new PiScienceClient();

    await client.createSession("/workspace");

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ cwd: "/workspace", config: {} });
  });

  it("allows a desktop cold-start session to outlive the default request timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    try {
      vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }));
      const pending = new PiScienceClient().createSession("/workspace");
      const rejection = expect(pending).rejects.toThrow("Request timed out while contacting the Pi-Science backend");

      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(SESSION_CREATION_TIMEOUT_MS - REQUEST_TIMEOUT_MS);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces delete failures instead of silently removing the UI entry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: "cannot delete a conversation while it is running",
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    })));
    const client = new PiScienceClient();

    await expect(client.deleteSession("session-a", "/workspace"))
      .rejects.toThrow("cannot delete");
  });

  it("preserves backend detail errors across conversation endpoints", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "session index unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Invalid API key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new PiScienceClient();

    await expect(client.listSessions("/workspace")).rejects.toThrow("session index unavailable");
    await expect(client.sendPrompt("session-a", "hello", "/workspace")).rejects.toThrow("Invalid API key");
  });

  it("requests paginated history and returns the cursor metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      messages: [{ id: "m2", role: "assistant", content: [] }],
      next_cursor: "eyJ2IjoxLCJvIjoxMjN9",
      has_more: true,
      snapshot_version: "456:789",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new PiScienceClient();

    const page = await client.getMessagesPage("session-a", "/workspace", { before: "cursor/1", limit: 25 });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/sessions/session-a/messages?cwd=%2Fworkspace&before=cursor%2F1&limit=25");
    expect(page).toMatchObject({ next_cursor: "eyJ2IjoxLCJvIjoxMjN9", has_more: true, snapshot_version: "456:789" });
    expect(page.messages[0]?.id).toBe("m2");
  });

  it("requests the lightweight user-message index", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      messages: [{ id: "u1", text: "first question", before: "cursor-u1" }],
      snapshot_version: "456:789",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new PiScienceClient();

    const index = await client.getUserMessageIndex("session-a", "/workspace");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/sessions/session-a/messages/index?cwd=%2Fworkspace");
    expect(index.messages).toEqual([{ id: "u1", text: "first question", before: "cursor-u1" }]);
  });
});
