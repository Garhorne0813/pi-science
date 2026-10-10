import { describe, expect, it } from "vitest";
import { inlineWorkspaceReferences, updateComposerDocument, validComposerEntities, type ComposerDocument } from "./composer-document";

const ref = { cwd: "/workspace", path: "data/protein.csv", name: "protein.csv", isDir: false };
const reference = (start: number, id = "ref-1") => ({
  id, kind: "reference" as const, start, end: start + "@data/protein.csv".length, reference: ref,
});

describe("composer structured document", () => {
  it("shifts entity ranges when text before them changes", () => {
    const document: ComposerDocument = { value: "Use @data/protein.csv", entities: [reference(4)] };
    const next = updateComposerDocument(document, "Please use @data/protein.csv");
    expect(next.entities[0]).toMatchObject({ start: 11, end: 28 });
    expect(next.value).toBe("Please use @data/protein.csv");
  });

  it("deletes the full entity on a partial edit and removes its reference identity", () => {
    const document: ComposerDocument = { value: "Use @data/protein.csv now", entities: [reference(4)] };
    const next = updateComposerDocument(document, "Use @data/protein.cs now");
    expect(next.value).toBe("Use  now");
    expect(inlineWorkspaceReferences(next.entities)).toEqual([]);
  });

  it("preserves occurrences, deduplicates referenced objects for sending", () => {
    const token = "@data/protein.csv";
    const document: ComposerDocument = {
      value: `${token} then ${token}`,
      entities: [reference(0), reference(token.length + 6, "ref-2")],
    };
    expect(validComposerEntities(document.value, document.entities)).toHaveLength(2);
    expect(inlineWorkspaceReferences(document.entities)).toEqual([ref]);
  });

  it("drops malformed, overlapping and stale identity metadata without changing text", () => {
    const value = "@data/protein.csv";
    expect(validComposerEntities(value, [reference(0), reference(0, "dup"), reference(300, "bad")])).toHaveLength(1);
    expect(validComposerEntities("@other.csv", [reference(0)])).toEqual([]);
  });

  it("keeps a pasted @ path as plain text when no structured entity was selected", () => {
    expect(updateComposerDocument({ value: "", entities: [] }, "@data/protein.csv").entities).toEqual([]);
  });
});
