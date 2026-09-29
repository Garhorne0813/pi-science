import { describe, expect, it } from "vitest";
import { commonPrefix, completionScope, completionView, completeQuery, detectCompletion, planAccept, planTab } from "./engine";
import type { DetectedCompletion } from "./engine";
import type { CompletionContext, CompletionItem, CompletionProvider, CompletionQuery } from "./types";

const context: CompletionContext = { value: "", caret: 0, cwd: "/workspace", entries: [], agents: [], commands: [] };

function item(insertText: string, kind: CompletionItem["kind"] = "file", extra: Partial<CompletionItem> = {}): CompletionItem {
  return { id: `item:${insertText}`, kind, label: insertText, insertText, ...extra };
}

function fakeProvider(id: string, trigger: CompletionProvider["trigger"], overrides: Partial<CompletionProvider> = {}): CompletionProvider {
  return { id, trigger, detect: () => null, complete: () => [], ...overrides };
}

describe("completionScope", () => {
  it("names a menu by provider, span start, and owned token", () => {
    expect(completionScope({ providerId: "path", kind: "directory", start: 4, end: 10, query: "results/pro" })).toBe("path:4");
  });
});

describe("commonPrefix", () => {
  it("is empty for no candidates", () => {
    expect(commonPrefix([])).toBe("");
  });

  it("is the whole insert text for one candidate", () => {
    expect(commonPrefix([item("protein.csv")])).toBe("protein.csv");
  });

  it("is the shared head of every insert text", () => {
    expect(commonPrefix([item("protein.csv"), item("protein_old.csv"), item("proteins/")])).toBe("protein");
  });

  it("is empty when the candidates diverge at the first character", () => {
    expect(commonPrefix([item("data/a.csv"), item("results/b.csv")])).toBe("");
  });
});

describe("detectCompletion", () => {
  it("returns the first provider that claims the caret", () => {
    const first = fakeProvider("first", "typing", { detect: (): CompletionQuery => ({ providerId: "first", kind: "command", start: 0, end: 2, query: "e" }) });
    const second = fakeProvider("second", "typing", { detect: (): CompletionQuery => ({ providerId: "second", kind: "command", start: 0, end: 2, query: "ex" }) });
    expect(detectCompletion([first, second], context)?.provider.id).toBe("first");
  });

  it("skips a provider that throws and uses the next one", () => {
    const broken = fakeProvider("broken", "typing", { detect: () => { throw new Error("no data source"); } });
    const second = fakeProvider("second", "typing", { detect: (): CompletionQuery => ({ providerId: "second", kind: "command", start: 0, end: 2, query: "ex" }) });
    expect(detectCompletion([broken, second], context)?.query.query).toBe("ex");
  });

  it("returns null when no provider claims the caret", () => {
    expect(detectCompletion([fakeProvider("a", "typing"), fakeProvider("b", "tab")], context)).toBeNull();
  });
});

describe("completeQuery", () => {
  it("returns the detected provider's candidates", () => {
    const candidate = item("/export", "command");
    const provider = fakeProvider("slash", "typing", { complete: () => [candidate] });
    expect(completeQuery({ provider, query: { providerId: "slash", kind: "command", start: 0, end: 2, query: "ex" } }, context)).toEqual([candidate]);
  });

  it("yields no candidates when the provider throws", () => {
    const provider = fakeProvider("path", "tab", { complete: () => { throw new Error("api down"); } });
    expect(completeQuery({ provider, query: { providerId: "path", kind: "directory", start: 0, end: 2, query: "pr" } }, context)).toEqual([]);
  });
});

describe("completionView", () => {
  const commandQuery: CompletionQuery = { providerId: "slash", kind: "command", start: 0, end: 2, query: "ex" };
  const candidates = [item("/export", "command")];

  it("shows a typing provider's list as soon as it has candidates", () => {
    const detected: DetectedCompletion = { provider: fakeProvider("slash", "typing"), query: commandQuery };
    expect(completionView({ detected, items: candidates, activeIndex: 0, dismissedScope: null, openedScope: null })).toEqual({
      visible: true, available: true, activeIndex: 0, activeItem: candidates[0],
    });
  });

  it("hides a dismissed scope but still reports it as available", () => {
    const detected: DetectedCompletion = { provider: fakeProvider("slash", "typing"), query: commandQuery };
    expect(completionView({ detected, items: candidates, activeIndex: 0, dismissedScope: "slash:0", openedScope: null })).toEqual({
      visible: false, available: false, activeIndex: 0, activeItem: candidates[0],
    });
  });

  it("keeps a dismissed token hidden while the user keeps typing inside it", () => {
    const grown: CompletionQuery = { providerId: "slash", kind: "command", start: 0, end: 5, query: "expor" };
    const detected: DetectedCompletion = { provider: fakeProvider("slash", "typing"), query: grown };
    expect(completionView({ detected, items: candidates, activeIndex: 0, dismissedScope: "slash:0", openedScope: null }).visible).toBe(false);
  });

  it("keeps a tab provider hidden until its key is opened", () => {
    const detected: DetectedCompletion = { provider: fakeProvider("path", "tab"), query: { providerId: "path", kind: "directory", start: 8, end: 10, query: "pr" } };
    expect(completionView({ detected, items: candidates, activeIndex: 0, dismissedScope: null, openedScope: null }).visible).toBe(false);
    expect(completionView({ detected, items: candidates, activeIndex: 0, dismissedScope: null, openedScope: null }).available).toBe(true);
    expect(completionView({ detected, items: candidates, activeIndex: 0, dismissedScope: null, openedScope: "path:8" }).visible).toBe(true);
  });

  it("has nothing available without candidates", () => {
    const detected: DetectedCompletion = { provider: fakeProvider("slash", "typing"), query: commandQuery };
    expect(completionView({ detected, items: [], activeIndex: 0, dismissedScope: null, openedScope: null })).toEqual({
      visible: false, available: false, activeIndex: 0, activeItem: null,
    });
  });

  it("is empty when nothing is detected", () => {
    expect(completionView({ detected: null, items: [], activeIndex: 0, dismissedScope: null, openedScope: null })).toEqual({
      visible: false, available: false, activeIndex: 0, activeItem: null,
    });
  });

  it("clamps the active index into the candidate range", () => {
    const detected: DetectedCompletion = { provider: fakeProvider("path", "tab"), query: { providerId: "path", kind: "directory", start: 8, end: 10, query: "pr" } };
    const list = [item("a"), item("b")];
    expect(completionView({ detected, items: list, activeIndex: 9, dismissedScope: null, openedScope: "path:8" })).toEqual({
      visible: true, available: true, activeIndex: 1, activeItem: list[1],
    });
    expect(completionView({ detected, items: list, activeIndex: -4, dismissedScope: null, openedScope: "path:8" }).activeIndex).toBe(0);
  });
});

describe("planTab", () => {
  const value = "compare pr";
  const pathDetected: DetectedCompletion = { provider: fakeProvider("path", "tab"), query: { providerId: "path", kind: "directory", start: 8, end: 10, query: "pr" } };
  const hidden = { visible: false, available: true, activeIndex: 0, activeItem: null };

  it("accepts the active item when the list is on screen", () => {
    const active = item("jsonl", "argument");
    const view = { visible: true, available: true, activeIndex: 0, activeItem: active };
    const detected: DetectedCompletion = { provider: fakeProvider("slash-argument", "typing"), query: { providerId: "slash-argument", kind: "argument", start: 8, end: 9, query: "j" } };
    expect(planTab({ view, detected, items: [active], value: "/export j", caret: 9 })).toEqual({
      kind: "apply", value: "/export jsonl", caret: 13, start: 8, end: 9,
    });
  });

  it("applies a single match through the common prefix", () => {
    expect(planTab({ view: hidden, detected: pathDetected, items: [item("protein.csv")], value, caret: 10 })).toEqual({
      kind: "apply", value: "compare protein.csv", caret: 19, start: 8, end: 10,
    });
  });

  it("fills the common prefix when several candidates match", () => {
    const items = [item("protein.csv"), item("protein_old.csv")];
    expect(planTab({ view: hidden, detected: pathDetected, items, value, caret: 10 })).toEqual({
      kind: "apply", value: "compare protein", caret: 15, start: 8, end: 10,
    });
  });

  it("opens the menu on a second Tab once the prefix cannot grow", () => {
    const items = [item("protein.csv"), item("protein_old.csv")];
    const detected: DetectedCompletion = { provider: fakeProvider("path", "tab"), query: { providerId: "path", kind: "directory", start: 8, end: 15, query: "protein" } };
    expect(planTab({ view: hidden, detected, items, value: "compare protein", caret: 15 })).toEqual({ kind: "open-menu" });
  });

  it("leaves Tab to the browser when there are no candidates", () => {
    expect(planTab({ view: hidden, detected: pathDetected, items: [], value, caret: 10 })).toEqual({ kind: "ignore" });
  });

  it("leaves Tab to the browser for a typing provider whose list is closed", () => {
    const detected: DetectedCompletion = { provider: fakeProvider("slash", "typing"), query: { providerId: "slash", kind: "command", start: 0, end: 2, query: "ex" } };
    expect(planTab({ view: hidden, detected, items: [item("/export", "command")], value: "ex", caret: 2 })).toEqual({ kind: "ignore" });
  });

  it("leaves Tab to the browser when nothing is detected", () => {
    expect(planTab({ view: hidden, detected: null, items: [], value: "hi", caret: 2 })).toEqual({ kind: "ignore" });
  });
});

describe("planAccept", () => {
  it("ignores a key with no query or no item", () => {
    expect(planAccept({ query: null, item: item("x"), value: "x" })).toEqual({ kind: "ignore" });
    expect(planAccept({ query: { providerId: "path", kind: "directory", start: 0, end: 1, query: "p" }, item: null, value: "p" })).toEqual({ kind: "ignore" });
  });

  it("ignores an exact match so the key keeps its normal meaning", () => {
    expect(planAccept({ query: { providerId: "slash", kind: "command", start: 0, end: 7, query: "export" }, item: item("/export", "command"), value: "/export" })).toEqual({ kind: "ignore" });
  });

  it("applies the item and passes its payload straight through", () => {
    const payload = { kind: "reference", reference: { path: "results/protein.csv", name: "protein.csv", isDir: false } } as const;
    const chosen = item("protein.csv", "file", { payload });
    expect(planAccept({ query: { providerId: "path", kind: "directory", start: 8, end: 10, query: "pr" }, item: chosen, value: "compare pr" })).toEqual({
      kind: "apply", value: "compare protein.csv", caret: 19, start: 8, end: 10, payload,
    });
  });
});
