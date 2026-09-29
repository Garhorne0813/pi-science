import { afterAll, beforeAll, describe, expect, it } from "vitest";
import i18n from "../../../i18n";
import { mentionProvider } from "./mention-provider";
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
    });
  });

  it("ignores an @ that is part of a word and a token that has ended", () => {
    expect(mentionProvider.detect(context("mail me at a@b"))).toBeNull();
    expect(mentionProvider.detect(context("@reviewer "))).toBeNull();
  });

  it("asks for a directory only when the token names one", () => {
    expect(mentionProvider.detect(context("pro"))).toBeNull();
    expect(detect("@").directory).toBeUndefined();
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

  it("lists the matching directory entries as workspace references", () => {
    expect(complete("@data/pro")).toEqual([
      {
        id: "mention:path:data/protein_structure",
        kind: "directory",
        label: "protein_structure/",
        description: "data/protein_structure",
        group: "files",
        insertText: "",
        payload: { kind: "reference", reference: { path: "data/protein_structure", name: "protein_structure", isDir: true } },
        size: 0,
      },
      {
        id: "mention:path:data/protein.csv",
        kind: "file",
        label: "protein.csv",
        description: "data/protein.csv",
        group: "files",
        insertText: "",
        payload: { kind: "reference", reference: { path: "data/protein.csv", name: "protein.csv", isDir: false } },
        size: 2048,
      },
    ]);
  });

  it("answers a bare @ with agents only", () => {
    expect(complete("@").map((item) => item.id)).toEqual(["mention:agent:reviewer", "mention:agent:scout"]);
  });

  it("leaves the candidate list empty when nothing matches", () => {
    expect(complete("@zzz")).toEqual([]);
    expect(complete("@data/zzz")).toEqual([]);
  });
});
