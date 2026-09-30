import { afterEach, describe, expect, it, vi } from "vitest";
import { allCommands, commandHint, commandTakesArguments, matchCommands, resetDynamicCommands } from "./slash-commands";
import type { SlashCommand } from "./slash-commands";
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

  it("keeps commands for their own workspace and drops them for another", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      commands: [{ name: "skill:review", description: "Review files", source: "skill" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const { dynamicCommandsFor, fetchDynamicCommands, retainDynamicCommands } = await import("./slash-commands");
    await fetchDynamicCommands("session-a", "/workspace-a");
    expect(dynamicCommandsFor("/workspace-a").map((command) => command.name)).toEqual(["skill:review"]);
    retainDynamicCommands("/workspace-a");
    expect(dynamicCommandsFor("/workspace-a").map((command) => command.name)).toEqual(["skill:review"]);
    retainDynamicCommands("/workspace-b");
    expect(dynamicCommandsFor("/workspace-b")).toEqual([]);
    expect(dynamicCommandsFor("/workspace-a")).toEqual([]);
  });

  it("ranks a name prefix above a name substring above a description match", () => {
    const commands: SlashCommand[] = [
      { name: "sync", description: "uploads changes", group: "utility" },
      { name: "backup", description: "snapshot", group: "utility" },
      { name: "upload", description: "send files", group: "utility" },
    ];
    expect(matchCommands("up", commands).map((command) => command.name)).toEqual(["upload", "backup", "sync"]);
  });

  it("keeps declaration order inside one rank", () => {
    const commands: SlashCommand[] = [
      { name: "group", description: "bundle", group: "utility" },
      { name: "backup", description: "snapshot", group: "utility" },
    ];
    expect(matchCommands("up", commands).map((command) => command.name)).toEqual(["group", "backup"]);
  });

  it("keeps every command in declaration order for an empty query", () => {
    const commands: SlashCommand[] = [
      { name: "group", description: "bundle", group: "utility" },
      { name: "backup", description: "snapshot", group: "utility" },
    ];
    expect(matchCommands("", commands).map((command) => command.name)).toEqual(["compact", "export", "group", "backup"]);
  });

  it("carries the export argument spec", () => {
    const exportCommand = allCommands().find((command) => command.name === "export")!;
    expect(exportCommand.arguments).toEqual([{ name: "format", required: false, values: ["html", "jsonl"], placeholder: "html|jsonl" }]);
    expect(commandTakesArguments(exportCommand)).toBe(true);
    expect(commandHint(exportCommand)).toBe("<html|jsonl>");
  });

  it("reports a command that declares no argument as taking none and having no hint", () => {
    const compact = allCommands().find((command) => command.name === "compact")!;
    expect(commandTakesArguments(compact)).toBe(false);
    expect(commandHint(compact)).toBeUndefined();
  });

  it("renders a hint from declared values when the server sent none", () => {
    const command: SlashCommand = {
      name: "run",
      description: "Run",
      group: "utility",
      arguments: [{ name: "mode", values: ["fast", "slow"] }, { name: "target", values: ["cpu", "gpu"] }],
    };
    expect(commandHint(command)).toBe("<fast|slow> <cpu|gpu>");
    expect(commandTakesArguments(command)).toBe(true);
  });
});
