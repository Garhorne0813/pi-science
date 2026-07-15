/**
 * Unit tests for slash command definitions and matching.
 */
import { describe, it, expect } from "vitest";
import { allCommands, matchCommands, resetDynamicCommands } from "./slash-commands";

describe("allCommands", () => {
  it("has all 7 built-in commands", () => {
    const names = allCommands().map((c) => c.name);
    expect(names).toContain("new");
    expect(names).toContain("name");
    expect(names).toContain("model");
    expect(names).toContain("compact");
    expect(names).toContain("session");
    expect(names).toContain("copy");
    expect(names).toContain("export");
  });

  it("every command has name, description, and group", () => {
    for (const cmd of allCommands()) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(["session", "workspace", "utility", "skill", "extension", "prompt"]).toContain(cmd.group);
    }
  });

  it("immediate commands have no argumentHint", () => {
    const immediate = allCommands().filter((c) => c.immediate);
    for (const cmd of immediate) {
      expect(cmd.argumentHint).toBeFalsy();
    }
  });

  it("argument commands have argumentHint", () => {
    const withArgs = allCommands().filter((c) => c.argumentHint);
    expect(withArgs.length).toBeGreaterThan(0);
    for (const cmd of withArgs) {
      expect(cmd.argumentHint).toBeTruthy();
    }
  });

  it("returns only builtin when no dynamic commands loaded", () => {
    resetDynamicCommands();
    // After reset, dynamic commands should be empty
    const cmds = allCommands();
    const nonBuiltin = cmds.filter(
      (c) => !["new", "name", "model", "compact", "session", "copy", "export"].includes(c.name),
    );
    expect(nonBuiltin).toHaveLength(0);
  });
});

describe("matchCommands", () => {
  it("returns all commands for empty prefix", () => {
    expect(matchCommands("")).toEqual(allCommands());
  });

  it("matches exact name", () => {
    const result = matchCommands("new");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("new");
  });

  it("matches partial name", () => {
    const result = matchCommands("co");
    expect(result.map((c) => c.name)).toContain("compact");
    expect(result.map((c) => c.name)).toContain("copy");
  });

  it("matches by description keyword", () => {
    const result = matchCommands("model");
    expect(result.map((c) => c.name)).toContain("model");
  });

  it("is case-insensitive", () => {
    expect(matchCommands("NEW")).toHaveLength(1);
    expect(matchCommands("New")[0].name).toBe("new");
  });

  it("returns empty array for no match", () => {
    expect(matchCommands("nonexistent")).toHaveLength(0);
  });

  it("prefix 'ex' matches export by name and compact by description", () => {
    // "ex" matches "export" (name) and "compact" (description contains "context")
    const result = matchCommands("ex");
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.map((c) => c.name)).toContain("export");
    expect(result.map((c) => c.name)).toContain("compact");
  });

  it("prefix 'exp' matches only export", () => {
    const result = matchCommands("exp");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("export");
  });
});
