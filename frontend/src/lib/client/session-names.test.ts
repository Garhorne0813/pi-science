import { describe, expect, it } from "vitest";

import { deriveSessionName, getSessionName, moveSessionName, setSessionName } from "./pi-science-client";
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

  it("does not throw when the session-name store holds a non-object value", () => {
    localStorage.setItem("pi-science.session-names", "null");
    expect(() => setSessionName("/workspace", "session-x", "My chat")).not.toThrow();
    expect(getSessionName("/workspace", "session-x")).toBe("My chat");
  });
});
