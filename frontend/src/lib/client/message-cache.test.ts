import { describe, expect, it, vi } from "vitest";

import { PiScienceClient } from "../pi-science-client";
import { installClientTestEnvironment } from "./test-helpers";


installClientTestEnvironment();


describe("PiScienceClient message cache", () => {
  it("drops a cached message entry that is missing a finite cachedAt", () => {
    localStorage.setItem("pi-science.msg-cache", JSON.stringify({
      "/workspace\0s": { messages: [{ id: "m", role: "user", content: [{ type: "text", text: "hi" }] }] },
    }));
    const client = new PiScienceClient();
    expect(client.getCachedMessages("s", "/workspace")).toBeNull();
    // The bad entry must be evicted from storage, not merely ignored.
    const stored = JSON.parse(localStorage.getItem("pi-science.msg-cache")!);
    expect(stored["/workspace\0s"]).toBeUndefined();
  });

  it("does not throw and sanitizes messages containing null or malformed entries", () => {
    localStorage.setItem("pi-science.msg-cache", JSON.stringify({
      "/workspace\0s": {
        cachedAt: Date.now(),
        messages: [
          null,
          { role: "user" }, // missing id
          { id: "m1", role: "user", content: [{ type: "text", text: "ok" }, null] },
          { id: "m2", role: "assistant", content: "not-an-array" },
        ],
      },
    }));
    const client = new PiScienceClient();
    expect(() => client.getCachedMessages("s", "/workspace")).not.toThrow();
    const cached = client.getCachedMessages("s", "/workspace");
    expect(cached).not.toBeNull();
    // Every surviving message is well-formed: string id/role and an array
    // content with no null elements.
    expect(cached!.every(
      (m) => typeof m.id === "string" && typeof m.role === "string" && Array.isArray(m.content),
    )).toBe(true);
    // The null content element in m1 is dropped; m2 keeps an empty array.
    const m1 = cached!.find((m) => m.id === "m1")!;
    expect(m1.content).toHaveLength(1);
  });

  it("does not throw when the cached message store holds a non-object value", async () => {
    // A corrupt or legacy entry could store the literal "null"; JSON.parse
    // returns null, which must not crash the cache read/write path.
    localStorage.setItem("pi-science.msg-cache", "null");
    const client = new PiScienceClient();
    expect(() => client.getCachedMessages("session-x", "/workspace")).not.toThrow();
    expect(client.getCachedMessages("session-x", "/workspace")).toBeNull();

    // A subsequent successful load must overwrite the corrupt entry.
    const messages = [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    await client.getMessages("session-x", "/workspace");
    expect(client.getCachedMessages("session-x", "/workspace")).toHaveLength(1);
  });

  it("caches messages after getMessages and serves them on getCachedMessages", async () => {
    const messages = [
      { id: "m1", role: "user", content: [{ type: "text", text: "hi" }] },
      { id: "m2", role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const client = new PiScienceClient();

    // Before the first fetch, no cache.
    expect(client.getCachedMessages("session-x", "/workspace")).toBeNull();

    await client.getMessages("session-x", "/workspace");

    const cached = client.getCachedMessages("session-x", "/workspace");
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(2);
    expect(cached![0].content[0]?.text).toBe("hi");
  });

  it("returns null for a session that has never been fetched", () => {
    const client = new PiScienceClient();
    expect(client.getCachedMessages("never-fetched", "/workspace")).toBeNull();
  });

  it("isolates cache by workspace — same sessionId different cwd", async () => {
    const messagesA = [{ id: "m1", role: "user", content: [{ type: "text", text: "secret-A" }] }];
    const messagesB = [{ id: "m1", role: "user", content: [{ type: "text", text: "secret-B" }] }];
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      const messages = callCount === 1 ? messagesA : messagesB;
      return Promise.resolve(new Response(JSON.stringify({ messages }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));
    const client = new PiScienceClient();

    // Fetch session-x in workspace-A
    await client.getMessages("same-id", "/workspace-A");
    // Fetch session-x in workspace-B
    await client.getMessages("same-id", "/workspace-B");

    // Cache must be isolated — A must not leak into B
    const cachedA = client.getCachedMessages("same-id", "/workspace-A");
    const cachedB = client.getCachedMessages("same-id", "/workspace-B");
    expect(cachedA![0].content[0]?.text).toBe("secret-A");
    expect(cachedB![0].content[0]?.text).toBe("secret-B");
  });

  it("removes all expired entries when any cache entry is read", () => {
    const now = Date.now();
    localStorage.setItem("pi-science.msg-cache", JSON.stringify({
      "/workspace\0expired": {
        cachedAt: now - 31 * 60 * 1000,
        messages: [{ id: "old", role: "user", content: [] }],
      },
      "/workspace\0future": {
        cachedAt: now + 60 * 60 * 1000,
        messages: [{ id: "future", role: "user", content: [] }],
      },
    }));
    const client = new PiScienceClient();
    expect(client.getCachedMessages("missing", "/workspace")).toBeNull();
    const stored = JSON.parse(localStorage.getItem("pi-science.msg-cache")!);
    expect(stored).toEqual({});
  });
});
