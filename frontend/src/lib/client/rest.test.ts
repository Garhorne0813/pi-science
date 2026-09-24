import { describe, expect, it, vi } from "vitest";

import { REQUEST_TIMEOUT_MS, RUNTIME_START_TIMEOUT_MS } from "./http";
import { PiScienceClient } from "./pi-science-client";
import { installClientTestEnvironment } from "./test-helpers";


installClientTestEnvironment();


describe("PiScienceClient REST calls", () => {
  it("sends a stable client message ID and reads its delivery status", async () => {
    const id = "8fd824aa-51d3-4f63-839c-09e021b7970b";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, status: "accepted", client_message_id: id }), { status: 202, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, status: "persisted", client_message_id: id, durable_message_id: "durable-1" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new PiScienceClient();

    await expect(client.sendPrompt("session-a", "status", id, "/workspace")).resolves.toMatchObject({ status: "accepted", client_message_id: id });
    await expect(client.getPromptRequestStatus("session-a", id, "/workspace")).resolves.toMatchObject({ status: "persisted", durable_message_id: "durable-1" });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ message: "status", client_message_id: id });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`/api/sessions/session-a/prompt-requests/${id}?cwd=%2Fworkspace`);
  });

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

  it("preserves structured error metadata from abort responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      code: "runtime_evicted",
      error: "Pi runtime was evicted",
    }), {
      status: 410,
      headers: { "Content-Type": "application/json" },
    })));
    const client = new PiScienceClient();

    await expect(client.abort("session-a", "/workspace")).rejects.toMatchObject({
      code: "runtime_evicted",
      status: 410,
    });
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
    await expect(client.sendPrompt("session-a", "hello", "8fd824aa-51d3-4f63-839c-09e021b7970b", "/workspace")).rejects.toThrow("Invalid API key");
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

  it("keeps client message identity in history and the restored message cache", async () => {
    const id = "8fd824aa-51d3-4f63-839c-09e021b7970b";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      messages: [{ id: "durable-1", role: "user", client_message_id: id, content: [{ type: "text", text: "status" }] }],
      next_cursor: null,
      has_more: false,
      snapshot_version: "1:1",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const client = new PiScienceClient();

    const page = await client.getMessagesPage("session-a", "/workspace");
    expect(page.messages[0]?.client_message_id).toBe(id);
    expect(client.getCachedMessages("session-a", "/workspace")?.[0]?.client_message_id).toBe(id);
  });

  it("preserves structured tool details through the history wire schema", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      messages: [{ id: "r1", role: "toolResult", content: [], details: { rows: 3 } }],
      next_cursor: null,
      has_more: false,
      snapshot_version: "1:1",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const page = await new PiScienceClient().getMessagesPage("session-a", "/workspace");
    expect(page.messages[0]?.details).toEqual({ rows: 3 });
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

  it("rejects malformed wire payloads at the REST seam", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      messages: [{ id: "m1", role: "assistant", content: [] }],
      next_cursor: null,
      has_more: "yes",
      snapshot_version: "456:789",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const client = new PiScienceClient();

    await expect(client.getMessagesPage("session-a", "/workspace"))
      .rejects.toThrow("Load messages failed: invalid response payload");
  });

  it("accepts a prompt acknowledgment that arrives after the old REST budget", async () => {
    vi.useFakeTimers();
    try {
      // A prompt can wait on a first-time workspace provision, which takes tens
      // of seconds. Model a 50s acknowledgment and abort on signal so the old
      // 45s budget would reject this request as a timeout.
      vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        const timer = globalThis.setTimeout(() => resolve(new Response(
          JSON.stringify({ ok: true, id: "session-a" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )), 50_000);
        init?.signal?.addEventListener("abort", () => {
          globalThis.clearTimeout(timer);
          reject(new Error("Request timed out while contacting the Pi-Science backend"));
        });
      })));
      const client = new PiScienceClient();

      const pending = client.sendPrompt("session-a", "hello", "/workspace");
      await vi.advanceTimersByTimeAsync(50_000);

      // The acknowledgment is accepted as long as the runtime-start budget
      // holds; the delivery state itself is main's prompt-request protocol.
      await expect(pending).resolves.toMatchObject({ status: "accepted" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("budgets a prompt like a runtime start, not like an ordinary read", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, id: "session-a" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      const client = new PiScienceClient();
      await client.sendPrompt("session-a", "hello", "/workspace");

      // A prompt can have to start the session runtime and provision the
      // workspace environment first. Aborting it at the ordinary REST budget
      // reports a timeout for a turn the backend still completes.
      const delays = timers.mock.calls.map((call) => call[1]);
      expect(delays).toContain(RUNTIME_START_TIMEOUT_MS);
      expect(delays).not.toContain(REQUEST_TIMEOUT_MS);
    } finally {
      timers.mockRestore();
    }
  });
});
