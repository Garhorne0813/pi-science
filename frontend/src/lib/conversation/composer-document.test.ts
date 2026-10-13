import { describe, expect, it } from "vitest";
import { applyComposerEdit, inlineWorkspaceReferences, updateComposerDocument, validComposerEntities, type ComposerDocument, type ComposerEntity } from "./composer-document";

const ref = { cwd: "/workspace", path: "data/protein.csv", name: "protein.csv", isDir: false };
const reference = (start: number, id = "ref-1") => ({
  id, kind: "reference" as const, start, end: start + "@data/protein.csv".length, reference: ref,
});
const edit = (document: ComposerDocument, selectionStart: number, selectionEnd = selectionStart, inputType = "insertText") => ({
  value: document.value, entities: document.entities, selectionStart, selectionEnd, inputType,
});

describe("composer structured document", () => {
  it("shifts entity ranges when text before them changes", () => {
    const document: ComposerDocument = { value: "Use @data/protein.csv", entities: [reference(4)] };
    const next = applyComposerEdit(document, edit(document, 0), "Please Use @data/protein.csv");
    expect(next.entities[0]).toMatchObject({ start: 11, end: 28 });
    expect(next.value).toBe("Please Use @data/protein.csv");
  });

  it("deletes the full entity on a partial edit and removes its reference identity", () => {
    const document: ComposerDocument = { value: "Use @data/protein.csv now", entities: [reference(4)] };
    const start = document.value.indexOf("csv") + 2;
    const next = applyComposerEdit(document, edit(document, start, start + 1, "deleteContentBackward"), "Use @data/protein.cs now");
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

  it("drops an unusable binding shape instead of throwing and leaves the text untouched", () => {
    const value = "@data/protein.csv";
    const malformed = [
      { id: "null-reference", kind: "reference", start: 0, end: value.length, reference: null },
      { id: "partial-reference", kind: "reference", start: 0, end: value.length, reference: { path: "data/protein.csv" } },
      { id: "bad-start", kind: "reference", start: 0.5, end: value.length, reference: ref },
      { id: "bad-name", kind: "mention", start: 0, end: 2, name: 7 },
      { id: "unknown-kind", kind: "widget", start: 0, end: value.length, reference: ref },
      null,
      "reference",
    ] as unknown as ComposerEntity[];
    expect(validComposerEntities(value, malformed)).toEqual([]);
    expect(validComposerEntities(value, [reference(0), ...malformed])).toEqual([reference(0)]);
    expect(updateComposerDocument({ value, entities: malformed }, value)).toEqual({ value, entities: [], caret: value.length });
  });

  it("rejects a second binding that repeats an accepted id", () => {
    const token = "@data/protein.csv";
    const value = `${token} and ${token}`;
    expect(validComposerEntities(value, [reference(0), reference(22, "ref-1")])).toEqual([reference(0)]);
  });

  it("keeps a binding and shifts its range when an untransacted edit inserts before it", () => {
    const document: ComposerDocument = { value: "@data/protein.csv", entities: [reference(0)] };
    expect(updateComposerDocument(document, "x @data/protein.csv")).toEqual({
      value: "x @data/protein.csv",
      entities: [{ ...reference(0), start: 2, end: 19 }],
      caret: 2,
    });
  });

  it("shifts a binding left when an untransacted edit deletes text before it", () => {
    const document: ComposerDocument = { value: "x @data/protein.csv", entities: [reference(2)] };
    expect(updateComposerDocument(document, " @data/protein.csv")).toEqual({
      value: " @data/protein.csv",
      entities: [{ ...reference(2), start: 1, end: 18 }],
      caret: 0,
    });
  });

  it("drops only the binding an untransacted edit touches and shifts the other one", () => {
    const token = "@data/protein.csv";
    const document: ComposerDocument = { value: `${token} and ${token}`, entities: [reference(0), reference(22, "ref-2")] };
    expect(updateComposerDocument(document, `${token.slice(0, 13)}X${token.slice(13)} and ${token}`)).toEqual({
      value: "X and @data/protein.csv",
      entities: [{ ...reference(22, "ref-2"), start: 6, end: 23 }],
      caret: 1,
    });
  });

  it("drops a binding and keeps the edited text when an untransacted edit replaces its whole token", () => {
    const document: ComposerDocument = { value: "Use @data/protein.csv", entities: [reference(4)] };
    expect(updateComposerDocument(document, "Use plain text here")).toEqual({ value: "Use plain text here", entities: [], caret: 19 });
  });

  it("shifts every binding of a 100-reference draft when an untransacted edit lands before them", () => {
    const token = "@data/protein.csv";
    const stride = token.length + 1;
    const value = Array.from({ length: 100 }, () => token).join(" ");
    const entities = Array.from({ length: 100 }, (_, index) => reference(index * stride, `ref-${index}`));
    const next = updateComposerDocument({ value, entities }, `x ${value}`);
    expect(next.value).toBe(`x ${value}`);
    expect(next.entities).toHaveLength(100);
    expect(next.entities[0]).toMatchObject({ start: 2, end: 2 + token.length });
    expect(next.entities[99]).toMatchObject({ start: 99 * stride + 2, end: 99 * stride + 2 + token.length });
    expect(next.caret).toBe(2);
  });

  it("keeps a pasted @ path as plain text when no structured entity was selected", () => {
    expect(updateComposerDocument({ value: "", entities: [] }, "@data/protein.csv").entities).toEqual([]);
  });

  it("uses the actual selection to remove the edited duplicate occurrence only", () => {
    const token = "@data/protein.csv";
    const document: ComposerDocument = {
      value: `${token} then ${token}`,
      entities: [reference(0), reference(token.length + 6, "ref-2")],
    };
    const next = applyComposerEdit(document, edit(document, 0, token.length, "deleteByCut"), document.value.slice(token.length));
    expect(next.value).toBe(` then ${token}`);
    expect(next.entities).toEqual([{ ...reference(0, "ref-2"), start: 6, end: 6 + token.length }]);
  });

  it("keeps a binding when an edit without an unambiguous input transaction appends text at its end", () => {
    const document: ComposerDocument = { value: "@data/protein.csv", entities: [reference(0)] };
    expect(updateComposerDocument(document, "@data/protein.csv!")).toEqual({ value: "@data/protein.csv!", entities: [reference(0)], caret: 18 });
  });
});

