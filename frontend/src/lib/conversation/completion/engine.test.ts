import { describe, expect, it } from "vitest";
import { commonPrefix, completionScope, completionView, completeQuery, detectCompletion, planAccept, planTab } from "./engine";
import type { DetectedCompletion } from "./engine";
import type { CompletionContext, CompletionItem, CompletionProvider, CompletionQuery } from "./types";

const context: CompletionContext = { value: "", caret: 0, cwd: "/workspace", entries: [], agents: [], commands: [] };

function item(insertText: string, kind: CompletionItem["kind"] = "file", extra: Partial<CompletionItem> = {}): CompletionItem {
  return { id: `item:${insertText}`, kind, label: insertText, insertText, ...extra };
}

function fakeProvider(id: string, overrides: Partial<CompletionProvider> = {}): CompletionProvider {
  return { id, detect: () => null, complete: () => [], ...overrides };
}

describe("completionScope", () => {
  it("names a menu by provider, span start, and owned token", () => {
    expect(completionScope({ providerId: "path", kind: "directory", start: 4, end: 10, query: "results/pro", autoOpen: true })).toBe("path:4");
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
    const first = fakeProvider("first", { detect: (): CompletionQuery => ({ providerId: "first", kind: "command", start: 0, end: 2, query: "e", autoOpen: true }) });
    const second = fakeProvider("second", { detect: (): CompletionQuery => ({ providerId: "second", kind: "command", start: 0, end: 2, query: "ex", autoOpen: true }) });
    expect(detectCompletion([first, second], context)?.provider.id).toBe("first");
  });

  it("skips a provider that throws and uses the next one", () => {
    const broken = fakeProvider("broken", { detect: () => { throw new Error("no data source"); } });
    const second = fakeProvider("second", { detect: (): CompletionQuery => ({ providerId: "second", kind: "command", start: 0, end: 2, query: "ex", autoOpen: true }) });
    expect(detectCompletion([broken, second], context)?.query.query).toBe("ex");
  });

  it("returns null when no provider claims the caret", () => {
    expect(detectCompletion([fakeProvider("a"), fakeProvider("b")], context)).toBeNull();
  });
});

describe("completeQuery", () => {
  it("returns the detected provider's candidates", () => {
    const candidate = item("/export", "command");
    const provider = fakeProvider("slash", { complete: () => [candidate] });
    expect(completeQuery({ provider, query: { providerId: "slash", kind: "command", start: 0, end: 2, query: "ex", autoOpen: true } }, context)).toEqual([candidate]);
  });

  it("yields no candidates when the provider throws", () => {
    const provider = fakeProvider("path", { complete: () => { throw new Error("api down"); } });
    expect(completeQuery({ provider, query: { providerId: "path", kind: "directory", start: 0, end: 2, query: "pr", autoOpen: false } }, context)).toEqual([]);
  });
});

describe("completionView", () => {
  const commandQuery: CompletionQuery = { providerId: "slash", kind: "command", start: 0, end: 2, query: "ex", autoOpen: true };
  const pathQuery: CompletionQuery = { providerId: "path", kind: "directory", start: 8, end: 10, query: "pr", autoOpen: false };
  const candidates = [item("/export", "command")];

  it("shows an autoOpen query's list as soon as it has candidates", () => {
    const detected: DetectedCompletion = { provider: fakeProvider("slash"), query: commandQuery };
    expect(completionView({ detected, items: candidates, activeIndex: 0, dismissedScope: null, openedScope: null, composing: false })).toEqual({
      visible: true, available: true, activeIndex: 0, activeItem: candidates[0],
    });
  });

  it("hides a query that does not open by itself until Tab opens its scope", () => {
    const detected: DetectedCompletion = { provider: fakeProvider("path"), query: pathQuery };
    const hidden = completionView({ detected, items: candidates, activeIndex: 0, dismissedScope: null, openedScope: null, composing: false });
    expect(hidden.visible).toBe(false);
    expect(hidden.available).toBe(true);
    expect(completionView({ detected, items: candidates, activeIndex: 0, dismissedScope: null, openedScope: "path:8", composing: false }).visible).toBe(true);
  });

  it("hides every list while the IME composes", () => {
    const detected: DetectedCompletion = { provider: fakeProvider("slash"), query: commandQuery };
    const view = completionView({ detected, items: candidates, activeIndex: 0, dismissedScope: null, openedScope: "slash:0", composing: true });
    expect(view.visible).toBe(false);
    expect(view.available).toBe(true);
  });

  it("hides a dismissed scope but still reports it as available", () => {
    const detected: DetectedCompletion = { provider: fakeProvider("slash"), query: commandQuery };
    expect(completionView({ detected, items: candidates, activeIndex: 0, dismissedScope: "slash:0", openedScope: null, composing: false })).toEqual({
      visible: false, available: false, activeIndex: 0, activeItem: candidates[0],
    });
  });

  it("keeps a dismissed token hidden while the user keeps typing inside it", () => {
    const grown: CompletionQuery = { providerId: "slash", kind: "command", start: 0, end: 5, query: "expor", autoOpen: true };
    const detected: DetectedCompletion = { provider: fakeProvider("slash"), query: grown };
    expect(completionView({ detected, items: candidates, activeIndex: 0, dismissedScope: "slash:0", openedScope: null, composing: false }).visible).toBe(false);
  });

  it("has nothing available without candidates", () => {
    const detected: DetectedCompletion = { provider: fakeProvider("slash"), query: commandQuery };
    expect(completionView({ detected, items: [], activeIndex: 0, dismissedScope: null, openedScope: null, composing: false })).toEqual({
      visible: false, available: false, activeIndex: 0, activeItem: null,
    });
  });

  it("is empty when nothing is detected", () => {
    expect(completionView({ detected: null, items: [], activeIndex: 0, dismissedScope: null, openedScope: null, composing: false })).toEqual({
      visible: false, available: false, activeIndex: 0, activeItem: null,
    });
  });

  it("clamps the active index into the candidate range", () => {
    const detected: DetectedCompletion = { provider: fakeProvider("path"), query: pathQuery };
    const list = [item("a"), item("b")];
    expect(completionView({ detected, items: list, activeIndex: 9, dismissedScope: null, openedScope: "path:8", composing: false })).toEqual({
      visible: true, available: true, activeIndex: 1, activeItem: list[1],
    });
    expect(completionView({ detected, items: list, activeIndex: -4, dismissedScope: null, openedScope: "path:8", composing: false }).activeIndex).toBe(0);
  });
});

describe("planTab", () => {
  const value = "compare pr";
  const pathDetected: DetectedCompletion = { provider: fakeProvider("path"), query: { providerId: "path", kind: "directory", start: 8, end: 10, query: "pr", autoOpen: false } };
  const hidden = { visible: false, available: true, activeIndex: 0, activeItem: null };

  it("accepts the active item when the list is on screen", () => {
    const active = item("jsonl", "argument");
    const view = { visible: true, available: true, activeIndex: 0, activeItem: active };
    const detected: DetectedCompletion = { provider: fakeProvider("slash-argument"), query: { providerId: "slash-argument", kind: "argument", start: 8, end: 9, query: "j", autoOpen: true } };
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
    const detected: DetectedCompletion = { provider: fakeProvider("path"), query: { providerId: "path", kind: "directory", start: 8, end: 15, query: "protein", autoOpen: false } };
    expect(planTab({ view: hidden, detected, items, value: "compare protein", caret: 15 })).toEqual({ kind: "open-menu" });
  });

  it("leaves Tab to the browser when there are no candidates", () => {
    expect(planTab({ view: hidden, detected: pathDetected, items: [], value, caret: 10 })).toEqual({ kind: "ignore" });
  });

  it("brings a dismissed list back when Tab asks for it", () => {
    const dismissed = { visible: false, available: false, activeIndex: 0, activeItem: null };
    const detected: DetectedCompletion = { provider: fakeProvider("slash"), query: { providerId: "slash", kind: "command", start: 0, end: 2, query: "ex", autoOpen: true } };
    expect(planTab({ view: dismissed, detected, items: [item("/export", "command")], value: "ex", caret: 2 })).toEqual({ kind: "open-menu" });
  });

  it("leaves Tab to the browser when nothing is detected", () => {
    expect(planTab({ view: hidden, detected: null, items: [], value: "hi", caret: 2 })).toEqual({ kind: "ignore" });
  });
});

describe("planAccept", () => {
  it("ignores a key with no query or no item", () => {
    expect(planAccept({ query: null, item: item("x"), value: "x" })).toEqual({ kind: "ignore" });
    expect(planAccept({ query: { providerId: "path", kind: "directory", start: 0, end: 1, query: "p", autoOpen: true }, item: null, value: "p" })).toEqual({ kind: "ignore" });
  });

  it("ignores an exact match so the key keeps its normal meaning", () => {
    expect(planAccept({ query: { providerId: "slash", kind: "command", start: 0, end: 7, query: "export", autoOpen: true }, item: item("/export", "command"), value: "/export" })).toEqual({ kind: "ignore" });
  });

  it("applies the item and passes its payload straight through", () => {
    const payload = { kind: "reference", reference: { path: "results/protein.csv", name: "protein.csv", isDir: false } } as const;
    const chosen = item("protein.csv", "file", { payload });
    expect(planAccept({ query: { providerId: "path", kind: "directory", start: 8, end: 10, query: "pr", autoOpen: true }, item: chosen, value: "compare pr" })).toEqual({
      kind: "apply", value: "compare protein.csv", caret: 19, start: 8, end: 10, payload,
    });
  });
});
