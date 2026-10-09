import { describe, expect, it } from "vitest";
import { completionView, planTab } from "./engine";
import { compareEntries, pathProvider, splitPathToken } from "./path-provider";
import type { CompletionContext, CompletionEntry } from "./types";

const context = (value: string, entries: readonly CompletionEntry[] = []): CompletionContext => ({
  value, caret: value.length, cwd: "/workspace", entries, agents: [], commands: [],
});

describe("splitPathToken", () => {
  it("splits at the last slash", () => {
    expect(splitPathToken("results/pro")).toEqual({ subdir: "results", prefix: "pro", base: "results/" });
  });

  it("keeps a leading ./ in base and strips it from subdir", () => {
    expect(splitPathToken("./results/pro")).toEqual({ subdir: "results", prefix: "pro", base: "./results/" });
  });

  it("normalises a leading ./ over the workspace root", () => {
    expect(splitPathToken("./pro")).toEqual({ subdir: "", prefix: "pro", base: "./" });
  });

  it("splits a file token into its directory", () => {
    expect(splitPathToken("data/a.csv")).toEqual({ subdir: "data", prefix: "a.csv", base: "data/" });
  });

  it("treats a bare name as the root prefix", () => {
    expect(splitPathToken("pro")).toEqual({ subdir: "", prefix: "pro", base: "" });
  });

  it("gives a trailing slash an empty prefix", () => {
    expect(splitPathToken("results/")).toEqual({ subdir: "results", prefix: "", base: "results/" });
  });

  it("rejects the empty token", () => {
    expect(splitPathToken("")).toBeNull();
  });

  it("rejects absolute paths", () => {
    expect(splitPathToken("/abs/path")).toBeNull();
  });

  it("rejects a parent segment in the directory", () => {
    expect(splitPathToken("../up")).toBeNull();
  });

  it("rejects mention tokens", () => {
    expect(splitPathToken("a@b")).toBeNull();
  });
});

describe("pathProvider.detect", () => {
  it("detects the bare path token ending at the caret", () => {
    expect(pathProvider.detect(context("compare results/pro"))).toEqual({
      providerId: "path",
      kind: "directory",
      start: 8,
      end: 19,
      query: "results/pro",
      directory: { subdir: "results", prefix: "pro", base: "results/" },
      autoOpen: true,
    });
  });

  it("keeps the menu closed for a bare word the user is not writing as a path", () => {
    expect(pathProvider.detect(context("protein"))!.autoOpen).toBe(false);
  });

  it("detects nothing when no token precedes the caret", () => {
    expect(pathProvider.detect(context("compare "))).toBeNull();
    expect(pathProvider.detect(context(""))).toBeNull();
  });
});

describe("pathProvider.complete", () => {
  const entries: CompletionEntry[] = [
    { name: "protein.csv", path: "results/protein.csv", isDir: false, size: 2048 },
    { name: "protein_old.csv", path: "results/protein_old.csv", isDir: false, size: 512 },
    { name: "proteins", path: "results/proteins", isDir: true, size: 0 },
  ];

  it("lists matching entries directories first, then files in name order", () => {
    expect(pathProvider.complete(pathProvider.detect(context("compare results/pro"))!, context("compare results/pro", entries))).toEqual([
      { id: "path:results/proteins", kind: "directory", label: "proteins/", insertText: "results/proteins/", size: 0, description: "results/proteins" },
      { id: "path:results/protein_old.csv", kind: "file", label: "protein_old.csv", insertText: "results/protein_old.csv", size: 512, description: "results/protein_old.csv" },
      { id: "path:results/protein.csv", kind: "file", label: "protein.csv", insertText: "results/protein.csv", size: 2048, description: "results/protein.csv" },
    ]);
  });

  it("matches the prefix case-insensitively", () => {
    const query = pathProvider.detect(context("compare results/PRO"))!;
    expect(pathProvider.complete(query, context("compare results/PRO", entries)).map((candidate) => candidate.label)).toEqual([
      "proteins/", "protein_old.csv", "protein.csv",
    ]);
  });

  it("lists every entry when the prefix is empty", () => {
    const query = pathProvider.detect(context("results/"))!;
    expect(pathProvider.complete(query, context("results/", entries)).map((candidate) => candidate.label)).toEqual([
      "proteins/", "protein_old.csv", "protein.csv",
    ]);
  });

  it("returns no candidates while the directory listing is empty", () => {
    expect(pathProvider.complete(pathProvider.detect(context("results/pro"))!, context("results/pro"))).toEqual([]);
  });

  it("filters the root listing by the bare-token prefix", () => {
    const rootEntries: CompletionEntry[] = [
      { name: "protein.csv", path: "protein.csv", isDir: false, size: 2048 },
      { name: "protein_old.csv", path: "protein_old.csv", isDir: false, size: 512 },
      { name: "protein_structure", path: "protein_structure", isDir: true, size: 0 },
      { name: "notes.txt", path: "notes.txt", isDir: false, size: 10 },
    ];
    const query = pathProvider.detect(context("pro"))!;
    expect(query.directory).toEqual({ subdir: "", prefix: "pro", base: "" });
    const candidates = pathProvider.complete(query, context("pro", rootEntries));
    expect(candidates.map((candidate) => candidate.insertText)).toEqual([
      "protein_structure/", "protein_old.csv", "protein.csv",
    ]);
    expect(candidates.map((candidate) => candidate.description)).toEqual([undefined, undefined, undefined]);
  });

  it("fills the bare-token prefix without opening the list", () => {
    const rootEntries: CompletionEntry[] = [
      { name: "protein.csv", path: "protein.csv", isDir: false, size: 2048 },
      { name: "protein_old.csv", path: "protein_old.csv", isDir: false, size: 512 },
      { name: "protein_structure", path: "protein_structure", isDir: true, size: 0 },
    ];
    const value = "pro";
    const detected = { provider: pathProvider, query: pathProvider.detect(context(value))! };
    const items = pathProvider.complete(detected.query, context(value, rootEntries));
    const view = completionView({ detected, items, activeIndex: 0, dismissedScope: null, openedScope: null, composing: false });
    expect(planTab({ view, detected, items, value, caret: 3 })).toEqual({ kind: "apply", value: "protein", caret: 7, start: 0, end: 3 });
  });
});

describe("compareEntries", () => {
  it("orders directories before files", () => {
    const dir: CompletionEntry = { name: "structures", path: "structures", isDir: true };
    const file: CompletionEntry = { name: "results.csv", path: "results.csv", isDir: false };
    expect([file, dir].sort(compareEntries).map((entry) => entry.name)).toEqual(["structures", "results.csv"]);
  });

  it("orders two names in one group case-insensitively", () => {
    expect(compareEntries({ name: "alpha", path: "alpha", isDir: false }, { name: "Beta", path: "Beta", isDir: false })).toBeLessThan(0);
  });
});
