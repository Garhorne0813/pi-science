import { afterEach, describe, expect, it, vi } from "vitest";
import { allCommands, matchCommands, resetDynamicCommands } from "./slash-commands";
import { queryClient } from "../client/query-client";

afterEach(() => {
  resetDynamicCommands();
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe("slash commands", () => {
  it("exposes the built-in command set", () => {
    expect(allCommands().map((command) => command.name)).toEqual([
      "compact", "export",
    ]);
  });

  it("matches command names and descriptions case-insensitively", () => {
    expect(matchCommands("EXP").map((command) => command.name)).toEqual(["export"]);
    expect(matchCommands("compact").map((command) => command.name)).toContain("compact");
  });

  it("loads and deduplicates dynamic commands", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      commands: [
        { name: "compact", description: "shadow" },
        { name: "skill:review", description: "Review files", source: "skill" },
        { name: "deploy", description: "Deploy files", source: "extension" },
        { name: "summarize", description: "Summarize text", source: "prompt" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const { fetchDynamicCommands } = await import("./slash-commands");
    await fetchDynamicCommands("session-a", "/workspace");
    expect(allCommands().map((command) => command.name)).toContain("skill:review");
    expect(allCommands().map((command) => command.name)).not.toContain("deploy");
    expect(allCommands().map((command) => command.name)).not.toContain("summarize");
    expect(allCommands().filter((command) => command.name === "compact")).toHaveLength(1);
  });
});
