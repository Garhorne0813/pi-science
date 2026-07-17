import { afterEach, describe, expect, it, vi } from "vitest";
import { allCommands, matchCommands, resetDynamicCommands } from "./slash-commands";

afterEach(() => {
  resetDynamicCommands();
  vi.unstubAllGlobals();
});

describe("slash commands", () => {
  it("exposes the built-in command set", () => {
    expect(allCommands().map((command) => command.name)).toEqual([
      "new", "name", "model", "compact", "session", "copy", "export",
    ]);
  });

  it("matches command names and descriptions case-insensitively", () => {
    expect(matchCommands("NEW").map((command) => command.name)).toEqual(["new"]);
    expect(matchCommands("compact").map((command) => command.name)).toContain("compact");
  });

  it("loads and deduplicates dynamic commands", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      commands: [
        { name: "new", description: "shadow" },
        { name: "review", description: "Review files", source: "skill" },
      ],
    }), { status: 200 })));
    const { fetchDynamicCommands } = await import("./slash-commands");
    await fetchDynamicCommands("session-a", "/workspace");
    expect(allCommands().map((command) => command.name)).toContain("review");
    expect(allCommands().filter((command) => command.name === "new")).toHaveLength(1);
  });
});
