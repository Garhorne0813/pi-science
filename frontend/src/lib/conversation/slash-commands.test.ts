import { afterEach, describe, expect, it, vi } from "vitest";
import { allCommands, commandHint, commandTakesArguments, matchCommands, slashCommandsKey, slashCommandsPrefix, slashCommandsRoot, slashCommandsQuery } from "./slash-commands";
import type { SlashCommand } from "./slash-commands";
import { queryClient } from "../client/query-client";

afterEach(() => {
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
    const commands = await queryClient.fetchQuery(slashCommandsQuery("/workspace"));
    expect(allCommands(commands).map((command) => command.name)).toContain("skill:review");
    expect(allCommands(commands).map((command) => command.name)).not.toContain("deploy");
    expect(allCommands(commands)).toContainEqual(expect.objectContaining({ name: "summarize", group: "utility", source: "prompt" }));
    expect(allCommands(commands).filter((command) => command.name === "compact")).toHaveLength(1);
  });

  it("isolates workspace catalogues when requests finish out of order", async () => {
    const resolve = new Map<string, (response: Response) => void>();
    vi.stubGlobal("fetch", vi.fn((url: string) => new Promise<Response>((done) => { resolve.set(url, done); })));
    const a = slashCommandsQuery("/a");
    const b = slashCommandsQuery("/b");
    const first = queryClient.fetchQuery(a);
    const second = queryClient.fetchQuery(b);
    const finish = (index: number, name: string) => [...resolve.values()][index](new Response(JSON.stringify({
      commands: [{ name: `skill:${name}`, source: "skill" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    finish(1, "b"); await second;
    finish(0, "a"); await first;
    expect(queryClient.getQueryData(a.queryKey)).toMatchObject([{ name: "skill:a" }]);
    expect(queryClient.getQueryData(b.queryKey)).toMatchObject([{ name: "skill:b" }]);
  });

  it("loads the catalogue without a session and marks session commands", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ commands: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const query = slashCommandsQuery("/workspace");
    expect(query.enabled).toBe(true);
    await queryClient.fetchQuery(query);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/api/composer/commands?");
    expect(allCommands().find((command) => command.name === "compact")?.requiresSession).toBe(true);
    expect(allCommands().find((command) => command.name === "export")?.requiresSession).toBe(true);
  });

  it("keeps an active session's command policy scoped to that session", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      commands: [{ name: "skill:session-only", description: "Session policy", source: "skill" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const query = slashCommandsQuery("/workspace", "session-1");
    expect(query.queryKey).toEqual(slashCommandsKey("/workspace", "session-1"));
    await queryClient.fetchQuery(query);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/api/sessions/session-1/commands?");
  });

  it("builds every catalogue key under the workspace prefix the invalidations use", () => {
    expect(slashCommandsPrefix("/workspace")).toEqual(["composer-commands", "/workspace"]);
    expect(slashCommandsPrefix("/workspace").slice(0, slashCommandsRoot.length)).toEqual(slashCommandsRoot);
    expect(slashCommandsKey("/workspace", "session-1")).toEqual(["composer-commands", "/workspace", "session-1"]);
    expect(slashCommandsKey("/workspace", null)).toEqual(["composer-commands", "/workspace", null]);
    expect(slashCommandsKey("/workspace", "session-1").slice(0, slashCommandsPrefix("/workspace").length)).toEqual(slashCommandsPrefix("/workspace"));
    expect(slashCommandsKey("/workspace", null).slice(0, slashCommandsPrefix("/workspace").length)).toEqual(slashCommandsPrefix("/workspace"));
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

