import { describe, expect, it } from "vitest";

import {
  aiTitleAttemptedAt,
  clearAiTitle,
  deriveSessionName,
  getSessionName,
  hasAiTitle,
  hasDerivedSessionName,
  markAiTitle,
  markAiTitleAttempted,
  moveSessionName,
  setSessionName,
} from "./pi-science-client";
import { installClientTestEnvironment } from "./test-helpers";


installClientTestEnvironment();


describe("deriveSessionName", () => {
  it("uses the first non-empty line and collapses internal whitespace", () => {
    expect(deriveSessionName("\n   \n  fix\t\tthe   parser bug  \nmore detail")).toBe("fix the parser bug");
  });

  it("caps names at 48 characters and appends an ellipsis", () => {
    expect(deriveSessionName("x".repeat(100))).toBe(`${"x".repeat(48)}…`);
    expect(deriveSessionName("x".repeat(48))).toBe("x".repeat(48));
  });

  it("returns an empty string for empty or whitespace-only input", () => {
    expect(deriveSessionName("")).toBe("");
    expect(deriveSessionName(" \n\t \r\n ")).toBe("");
  });
});

describe("session name migration and storage resilience", () => {
  it("migrates a v2 single-key session name to the composite (cwd, sessionId) key", () => {
    // Simulate a v2 payload stored before the composite-key change.
    localStorage.setItem("pi-science.session-names", JSON.stringify({ "legacy-id": "Old Name" }));
    expect(getSessionName("/workspace", "legacy-id")).toBe("Old Name");
    // The store should now hold the migrated composite key, not the bare id.
    const migrated = JSON.parse(localStorage.getItem("pi-science.session-names")!);
    expect(migrated["/workspace\0legacy-id"]).toBe("Old Name");
    expect(migrated["legacy-id"]).toBeUndefined();
  });

  it("returns an empty string (never an object) for a corrupt object name value", () => {
    localStorage.setItem("pi-science.session-names", JSON.stringify({ "/workspace\0bad": { bad: true } }));
    const value = getSessionName("/workspace", "bad");
    expect(typeof value).toBe("string");
    expect(value).toBe("");
  });

  it("moves a legacy name without restoring the bare legacy key", () => {
    localStorage.setItem("pi-science.session-names", JSON.stringify({ "legacy-id": "Legacy" }));
    expect(moveSessionName("/workspace", "legacy-id", "new-id")).toBe("Legacy");
    const stored = JSON.parse(localStorage.getItem("pi-science.session-names")!);
    expect(stored["/workspace\0new-id"]).toBe("Legacy");
    expect(stored["legacy-id"]).toBeUndefined();
  });

  it("never returns an object when the destination name is corrupt", () => {
    localStorage.setItem("pi-science.session-names", JSON.stringify({
      "/workspace\0old": "Old",
      "/workspace\0new": { bad: true },
    }));
    expect(moveSessionName("/workspace", "old", "new")).toBe("Old");
    expect(typeof getSessionName("/workspace", "new")).toBe("string");
  });

  it("moves the AI-title mark together with the display name", () => {
    setSessionName("/workspace", "old", "AI 标题");
    markAiTitle("/workspace", "old");
    expect(hasAiTitle("/workspace", "old")).toBe(true);
    expect(moveSessionName("/workspace", "old", "new")).toBe("AI 标题");
    expect(hasAiTitle("/workspace", "new")).toBe(true);
    expect(hasAiTitle("/workspace", "old")).toBe(false);
  });

  it("leaves the AI-title mark untouched when no name is moved", () => {
    markAiTitle("/workspace", "keep");
    moveSessionName("/workspace", "other", "keep");
    expect(hasAiTitle("/workspace", "keep")).toBe(true);
  });

  it("tracks failed AI-title attempts with timestamps", () => {
    expect(aiTitleAttemptedAt("/workspace", "session-x")).toBe(0);
    markAiTitleAttempted("/workspace", "session-x", 1234);
    expect(aiTitleAttemptedAt("/workspace", "session-x")).toBe(1234);
    markAiTitleAttempted("/workspace", "session-x");
    expect(aiTitleAttemptedAt("/workspace", "session-x")).toBeGreaterThan(0);
  });

  it("clears the AI-title mark and attempt separately", () => {
    markAiTitle("/workspace", "session-x");
    markAiTitleAttempted("/workspace", "session-x");
    clearAiTitle("/workspace", "session-x");
    expect(hasAiTitle("/workspace", "session-x")).toBe(false);
    expect(aiTitleAttemptedAt("/workspace", "session-x")).toBeGreaterThan(0);
  });

  it("does not throw when the session-name store holds a non-object value", () => {
    localStorage.setItem("pi-science.session-names", "null");
    expect(() => setSessionName("/workspace", "session-x", "My chat")).not.toThrow();
    expect(getSessionName("/workspace", "session-x")).toBe("My chat");
  });
});

describe("setSessionName server persistence", () => {
  it("writes the title to the server (PUT) without blocking the sync path", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      setSessionName("/workspace", "persist-me", "持久标题");
      // The localStorage write is immediate (sync contract).
      expect(getSessionName("/workspace", "persist-me")).toBe("持久标题");
      // Fire-and-forget: give the dynamic import + PUT a tick.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const put = calls.find((c) => c.url.includes("/api/sessions/persist-me/title") && c.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(put!.body ?? "").title).toBe("持久标题");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps the local name when the server write fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    try {
      setSessionName("/workspace", "fail-me", "离线标题");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getSessionName("/workspace", "fail-me")).toBe("离线标题");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("mirrors the server's 100-character title limit locally", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    try {
      // A persisted final title of exactly 100 characters must not be
      // truncated in localStorage (the old cap was 50).
      const exactly = "x".repeat(100);
      setSessionName("/workspace", "cap-exact", exactly);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getSessionName("/workspace", "cap-exact")).toBe(exactly);

      const longer = `${"y".repeat(100)}truncated`;
      setSessionName("/workspace", "cap-over", longer);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getSessionName("/workspace", "cap-over")).toBe("y".repeat(100));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("marks derived names and carries the mark through a replacement move", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    try {
      setSessionName("/workspace", "derived-old", "fallback question", { derived: true });
      expect(hasDerivedSessionName("/workspace", "derived-old")).toBe(true);

      moveSessionName("/workspace", "derived-old", "derived-new");
      expect(getSessionName("/workspace", "derived-new")).toBe("fallback question");
      expect(hasDerivedSessionName("/workspace", "derived-new")).toBe(true);
      expect(hasDerivedSessionName("/workspace", "derived-old")).toBe(false);

      // A final rename clears the derived mark.
      setSessionName("/workspace", "derived-new", "final name");
      expect(hasDerivedSessionName("/workspace", "derived-new")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
