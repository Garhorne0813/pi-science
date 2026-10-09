import { describe, expect, it } from "vitest";
import { allCommands } from "../slash-commands";
import { completionScope, completionView, planTab } from "./engine";
import { slashArgumentProvider } from "./slash-argument-provider";
import type { CompletionContext } from "./types";

const context = (value: string): CompletionContext => ({ value, caret: value.length, cwd: "/workspace", entries: [], agents: [], commands: allCommands() });

describe("slashArgumentProvider.detect", () => {
  it("detects the argument of a known command", () => {
    expect(slashArgumentProvider.detect(context("/export j"))).toEqual({
      providerId: "slash-argument", kind: "argument", start: 8, end: 9, query: "j", argument: { command: "export", index: 0 }, autoOpen: true,
    });
  });

  it("detects the empty argument right after the space", () => {
    expect(slashArgumentProvider.detect(context("/export "))).toEqual({
      providerId: "slash-argument", kind: "argument", start: 8, end: 8, query: "", argument: { command: "export", index: 0 }, autoOpen: false,
    });
  });

  it("detects nothing before the command name is finished", () => {
    expect(slashArgumentProvider.detect(context("/export"))).toBeNull();
  });

  it("detects nothing for a command that declares no values", () => {
    expect(slashArgumentProvider.detect(context("/compact "))).toBeNull();
  });

  it("detects nothing for an unknown command", () => {
    expect(slashArgumentProvider.detect(context("/nope x"))).toBeNull();
  });
});

describe("slashArgumentProvider.complete", () => {
  it("offers the argument values filtered by the typed prefix", () => {
    expect(slashArgumentProvider.complete(slashArgumentProvider.detect(context("/export j"))!, context("/export j"))).toEqual([
      { id: "argument:export:jsonl", kind: "argument", label: "jsonl", insertText: "jsonl", description: "format" },
    ]);
  });

  it("offers every value for the empty prefix", () => {
    expect(slashArgumentProvider.complete(slashArgumentProvider.detect(context("/export "))!, context("/export "))).toEqual([
      { id: "argument:export:html", kind: "argument", label: "html", insertText: "html", description: "format" },
      { id: "argument:export:jsonl", kind: "argument", label: "jsonl", insertText: "jsonl", description: "format" },
    ]);
  });

  it("matches the value prefix case-insensitively", () => {
    expect(slashArgumentProvider.complete(slashArgumentProvider.detect(context("/export J"))!, context("/export J")).map((item) => item.label)).toEqual(["jsonl"]);
  });
});

describe("slash argument Tab", () => {
  it("fills a partial argument to its only value", () => {
    const value = "/export j";
    const detected = { provider: slashArgumentProvider, query: slashArgumentProvider.detect(context(value))! };
    const items = slashArgumentProvider.complete(detected.query, context(value));
    const view = completionView({ detected, items, activeIndex: 0, dismissedScope: null, openedScope: null, composing: false });
    expect(planTab({ view, detected, items, value, caret: value.length })).toEqual({ kind: "apply", value: "/export jsonl", caret: 13, start: 8, end: 9 });
  });

  it("opens the value list on Tab and accepts the first value on the next Tab", () => {
    const value = "/export ";
    const detected = { provider: slashArgumentProvider, query: slashArgumentProvider.detect(context(value))! };
    const items = slashArgumentProvider.complete(detected.query, context(value));
    const closed = completionView({ detected, items, activeIndex: 0, dismissedScope: null, openedScope: null, composing: false });
    const opened = completionView({ detected, items, activeIndex: 0, dismissedScope: null, openedScope: completionScope(detected.query), composing: false });
    expect(items.map((item) => item.label)).toEqual(["html", "jsonl"]);
    expect(closed.visible).toBe(false);
    expect(planTab({ view: closed, detected, items, value, caret: value.length })).toEqual({ kind: "open-menu" });
    expect(planTab({ view: opened, detected, items, value, caret: value.length })).toEqual({ kind: "apply", value: "/export html", caret: 12, start: 8, end: 8 });
  });
});
