import { describe, expect, it } from "vitest";
import { allCommands } from "../slash-commands";
import { slashCommandProvider } from "./slash-provider";
import type { CompletionContext } from "./types";

const context = (value: string): CompletionContext => ({ value, caret: value.length, cwd: "/workspace", entries: [], agents: [], commands: allCommands() });

describe("slashCommandProvider.detect", () => {
  it("detects a slash command typed with no whitespace", () => {
    expect(slashCommandProvider.detect(context("/ex"))).toEqual({ providerId: "slash", kind: "command", start: 0, end: 3, query: "ex" });
  });

  it("leaves the caret alone once whitespace follows the command", () => {
    expect(slashCommandProvider.detect(context("/export "))).toBeNull();
  });

  it("leaves the caret alone away from the start of the input", () => {
    expect(slashCommandProvider.detect(context("run /export"))).toBeNull();
  });
});

describe("slashCommandProvider.complete", () => {
  it("offers a matching command with its hint and an argument space", () => {
    expect(slashCommandProvider.complete(slashCommandProvider.detect(context("/ex"))!, context("/ex"))).toEqual([
      { id: "command:export", kind: "command", label: "/export", description: "Export the session", detail: "<html|jsonl>", insertText: "/export " },
    ]);
  });

  it("offers a command with no arguments and no trailing space", () => {
    expect(slashCommandProvider.complete(slashCommandProvider.detect(context("/comp"))!, context("/comp"))).toEqual([
      { id: "command:compact", kind: "command", label: "/compact", description: "Compact the current session", detail: undefined, insertText: "/compact" },
    ]);
  });

  it("matches the command name case-insensitively", () => {
    expect(slashCommandProvider.complete(slashCommandProvider.detect(context("/EXP"))!, context("/EXP")).map((item) => item.label)).toEqual(["/export"]);
  });

  it("matches a description substring", () => {
    expect(slashCommandProvider.complete(slashCommandProvider.detect(context("/cur"))!, context("/cur")).map((item) => item.label)).toEqual(["/compact"]);
  });
});
