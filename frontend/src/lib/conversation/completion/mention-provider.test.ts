import { afterAll, beforeAll, describe, expect, it } from "vitest";
import i18n from "../../../i18n";
import { mentionProvider } from "./mention-provider";
import { planAccept } from "./engine";
import type { CompletionContext } from "./types";

const AGENTS = [
  { name: "reviewer", description: "Review work", source: "builtin" },
  { name: "scout", description: "Gather context", source: "builtin" },
];

const ENTRIES = [
  { name: "protein.csv", path: "data/protein.csv", isDir: false, size: 2048 },
  { name: "protein_structure", path: "data/protein_structure", isDir: true, size: 0 },
  { name: "notes.md", path: "data/notes.md", isDir: false, size: 10 },
];

function context(value: string, caret = value.length, entries = ENTRIES): CompletionContext {
  return { value, caret, cwd: "project", entries, agents: AGENTS, commands: [] };
}

function detect(value: string, caret = value.length) {
  const query = mentionProvider.detect(context(value, caret));
  if (!query) throw new Error(`no query for ${JSON.stringify(value)}`);
  return query;
}

function complete(value: string, caret = value.length, entries = ENTRIES) {
  return mentionProvider.complete(detect(value, caret), context(value, caret, entries));
}

beforeAll(async () => { await i18n.changeLanguage("en"); });
afterAll(async () => { await i18n.changeLanguage("en"); });

describe("mentionProvider detection", () => {
  it("claims the @ token that ends at the caret", () => {
    expect(detect("look at @rev")).toEqual({
      providerId: "mention",
      kind: "subagent",
      start: 8,
      end: 12,
      query: "rev",
      directory: { subdir: "", prefix: "rev", base: "" },
      autoOpen: true,
    });
  });

  it("ignores an @ that is part of a word and a token that has ended", () => {
    expect(mentionProvider.detect(context("mail me at a@b"))).toBeNull();
    expect(mentionProvider.detect(context("@reviewer "))).toBeNull();
  });

  it("uses the root directory for a bare @ and follows explicitly typed paths", () => {
    expect(mentionProvider.detect(context("pro"))).toBeNull();
    expect(detect("@").directory).toEqual({ subdir: "", prefix: "", base: "" });
    expect(detect("@data/pro").directory).toEqual({ subdir: "data", prefix: "pro", base: "data/" });
    expect(detect("@data/").directory).toEqual({ subdir: "data", prefix: "", base: "data/" });
  });
});

describe("mentionProvider candidates", () => {
  it("lists matching agents first and adds the space the token is missing", () => {
    expect(complete("@rev")).toEqual([
      {
        id: "mention:agent:reviewer",
        kind: "subagent",
        label: "@reviewer",
        description: "Review work",
        detail: "builtin",
        group: "agents",
        insertText: "@reviewer ",
        payload: { kind: "mention", name: "reviewer", token: "@reviewer" },
      },
    ]);
  });

  it("keeps the existing space when the draft already has one there", () => {
    expect(complete("@scout tail", 6)[0].insertText).toBe("@scout");
  });

  it("uses separate boundaries for agent names and file paths in a mixed list", () => {
    const value = "@rev,notes.csv tail";
    const caret = 4;
    const entries = [{ name: "rev,notes.csv", path: "rev,notes.csv", isDir: false, size: 10 }];
    const query = detect(value, caret);
    const candidates = complete(value, caret, entries);
    expect(candidates.map((item) => item.kind)).toEqual(["subagent", "file"]);
    expect(planAccept({ query, item: candidates[0], value })).toMatchObject({
      value: "@reviewer ,notes.csv tail", end: caret,
    });
    expect(planAccept({ query, item: candidates[1], value })).toMatchObject({
      // The token already ends at a space, so the accept keeps the single separator.
      value: "@rev,notes.csv tail", end: value.indexOf(" "),
      payload: { kind: "reference", reference: { path: "rev,notes.csv" } },
    });
  });

  it("separates directory navigation from explicit directory references", () => {
    expect(complete("@data/pro")).toEqual([
      {
        id: "mention:navigate:data/protein_structure",
        kind: "directory",
        label: "protein_structure/",
        description: "data/protein_structure",
        group: "files",
        insertText: "",
        payload: { kind: "navigate-directory", path: "data/protein_structure" },
        size: 0,
      },
      {
        id: "mention:directory-reference:data/protein_structure",
        kind: "directory",
        label: "protein_structure/",
        description: "data/protein_structure",
        group: "files",
        insertText: "@data/protein_structure ",
        payload: { kind: "reference", reference: { path: "data/protein_structure", name: "protein_structure", isDir: true } },
        size: 0,
      },
      {
        id: "mention:path:data/protein.csv",
        kind: "file",
        label: "protein.csv",
        description: "data/protein.csv",
        group: "files",
        insertText: "@data/protein.csv ",
        payload: { kind: "reference", reference: { path: "data/protein.csv", name: "protein.csv", isDir: false } },
        size: 2048,
      },
    ]);
  });

  it("prints a root entry's path only when it adds the directory", () => {
    const root = [{ name: "protein.csv", path: "protein.csv", isDir: false, size: 2048 }];
    const candidates = mentionProvider.complete(detect("@pro"), context("@pro", 4, root));
    expect(candidates.map((candidate) => candidate.description)).toEqual([undefined]);
    const nested = mentionProvider.complete(detect("@data/pro"), context("@data/pro"));
    expect(nested.map((candidate) => candidate.description)).toEqual(["data/protein_structure", "data/protein_structure", "data/protein.csv"]);
  });

  it("answers a bare @ with root files, folders, and agents", () => {
    expect(complete("@").map((item) => item.id)).toEqual([
      "mention:agent:reviewer", "mention:agent:scout",
      "mention:navigate:data/protein_structure", "mention:directory-reference:data/protein_structure",
      "mention:path:data/notes.md", "mention:path:data/protein.csv",
    ]);
  });

  it("leaves the candidate list empty when nothing matches", () => {
    expect(complete("@zzz")).toEqual([]);
    expect(complete("@data/zzz")).toEqual([]);
  });
});

