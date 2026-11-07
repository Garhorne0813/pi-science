import { describe, expect, it } from "vitest";
import {
  baseName, createDraft, createEdit, editErrorFor, parentDir, planCommit, projectEditRows, renameDraft, renameEdit, targetPath, isNameValid,
} from "./inline-file-edit";

describe("parentDir", () => {
  it.each([
    ["work/data.csv", "work"],
    ["work/plots/a.png", "work/plots"],
    ["data.csv", ""],
    ["", ""],
  ])("parentDir(%j) is %j", (path, expected) => {
    expect(parentDir(path)).toEqual(expected);
  });
});

describe("baseName", () => {
  it.each([
    ["work/data.csv", "data.csv"],
    ["data.csv", "data.csv"],
    ["", ""],
  ])("baseName(%j) is %j", (path, expected) => {
    expect(baseName(path)).toEqual(expected);
  });
});

describe("createEdit", () => {
  it("records the target folder plus its anchor row", () => {
    expect(createEdit("file", "work", "work")).toEqual({ mode: "create", kind: "file", dir: "work", anchor: "work" });
  });

  it("records a workspace-root target with no anchor row", () => {
    expect(createEdit("dir", "", null)).toEqual({ mode: "create", kind: "dir", dir: "", anchor: null });
  });
});

describe("renameEdit", () => {
  it.each([
    ["work/a.csv", false, { mode: "rename", kind: "file", path: "work/a.csv" }],
    ["work/plots", true, { mode: "rename", kind: "dir", path: "work/plots" }],
  ])("marks %j as %j", (path, isDir, expected) => {
    expect(renameEdit({ path, isDir })).toEqual(expected);
  });
});

describe("createDraft and renameDraft", () => {
  it("opens a create with an empty name and no error", () => {
    expect(createDraft("file", "work", "work")).toEqual({
      edit: { mode: "create", kind: "file", dir: "work", anchor: "work" }, value: "", saving: false, error: null,
    });
  });

  it("opens a rename with the entry's own name selected for editing", () => {
    expect(renameDraft({ path: "work/a.csv", isDir: false })).toEqual({
      edit: { mode: "rename", kind: "file", path: "work/a.csv" }, value: "a.csv", saving: false, error: null,
    });
  });
});

describe("targetPath", () => {
  it.each([
    [createEdit("file", "", null), "  notes.md  ", "notes.md"],
    [createEdit("file", "work", "work"), " notes.md ", "work/notes.md"],
    [createEdit("dir", "work/plots", "work/plots"), "2024", "work/plots/2024"],
    [createEdit("file", "work", "work"), "   ", ""],
    [renameEdit({ path: "work/a.csv", isDir: false }), "b.csv", "work/b.csv"],
    [renameEdit({ path: "a.csv", isDir: false }), "b.csv", "b.csv"],
    [renameEdit({ path: "work/a.csv", isDir: false }), "notes", "work/notes"],
    [renameEdit({ path: "work/plots", isDir: true }), "  ", ""],
  ])("targetPath of %j with %j is %j", (edit, name, expected) => {
    expect(targetPath(edit, name)).toEqual(expected);
  });
});

describe("isNameValid", () => {
  it.each([
    ["notes.md", true],
    ["a b", true],
    ["notes.md ", true],
    ["", false],
    ["   ", false],
    [".", false],
    ["..", false],
    ["/", false],
    ["\\", false],
    ["a/b", false],
    ["a\\b", false],
    ["/notes.md", false],
  ])("isNameValid(%j) is %j", (name, expected) => {
    expect(isNameValid(name)).toEqual(expected);
  });
});

describe("planCommit", () => {
  it("cancels a blank create instead of creating an unnamed entry", () => {
    expect(planCommit({ ...createDraft("file", "work", "work"), value: "   " })).toEqual({ kind: "cancel" });
  });

  it("rejects a rename to a blank name", () => {
    expect(planCommit({ ...renameDraft({ path: "work/a.csv", isDir: false }), value: "  " })).toEqual({ kind: "invalid" });
  });

  it.each(["a/b", ".", ".."])("rejects %j as a name", (value) => {
    expect(planCommit({ ...createDraft("dir", "", null), value })).toEqual({ kind: "invalid" });
  });

  it("does nothing when a file is renamed to its own name", () => {
    expect(planCommit(renameDraft({ path: "work/a.csv", isDir: false }))).toEqual({ kind: "unchanged" });
  });

  it("does nothing when a folder is renamed to its own name", () => {
    expect(planCommit(renameDraft({ path: "work/plots", isDir: true }))).toEqual({ kind: "unchanged" });
  });

  it.each([
    [createDraft("file", "work", "work"), "notes.md", { kind: "create-file", target: "work/notes.md" }],
    [createDraft("dir", "", null), "figures", { kind: "create-folder", target: "figures" }],
    [createDraft("dir", "work", "work"), "plots", { kind: "create-folder", target: "work/plots" }],
  ] as const)("plans a create for %j", (draft, value, mutation) => {
    expect(planCommit({ ...draft, value })).toEqual({ kind: "mutation", mutation });
  });

  it("plans a rename inside the entry's current folder", () => {
    expect(planCommit({ ...renameDraft({ path: "work/a.csv", isDir: false }), value: "b.csv" }))
      .toEqual({ kind: "mutation", mutation: { kind: "rename", source: "work/a.csv", target: "work/b.csv", isDir: false } });
  });

  it("marks a renamed folder as a directory", () => {
    expect(planCommit({ ...renameDraft({ path: "work/plots", isDir: true }), value: "figures" }))
      .toEqual({ kind: "mutation", mutation: { kind: "rename", source: "work/plots", target: "work/figures", isDir: true } });
  });
});

describe("editErrorFor", () => {
  it("reads a 409 as a name conflict", () => {
    expect(editErrorFor(Object.assign(new Error("File already exists"), { status: 409 }))).toEqual("conflict");
  });

  it.each([[{ status: 500 }], [new Error("boom")], [undefined], [null]])("treats %j as a request failure", (error) => {
    expect(editErrorFor(error)).toEqual("request");
  });
});

describe("projectEditRows", () => {
  const rows = [
    { path: "work", depth: 0 },
    { path: "work/data.csv", depth: 1 },
    { path: "reports", depth: 0 },
  ];

  it("passes every row through when nothing is being edited", () => {
    expect(projectEditRows(rows, null)).toEqual(rows.map((row) => ({ kind: "entry", row })));
  });

  it("puts a root create ahead of every row", () => {
    const projected = projectEditRows(rows, createDraft("dir", "", null));
    expect(projected[0]).toEqual({ kind: "editor", indent: 0 });
    expect(projected).toHaveLength(rows.length + 1);
    expect(projected.slice(1)).toEqual(rows.map((row) => ({ kind: "entry", row })));
  });

  it("nests a create under the folder it lands in, before that folder's children", () => {
    const projected = projectEditRows(rows, createDraft("file", "work", "work"));
    expect(projected).toEqual([
      { kind: "entry", row: rows[0] },
      { kind: "editor", indent: 1 },
      { kind: "entry", row: rows[1] },
      { kind: "entry", row: rows[2] },
    ]);
  });

  it("renders a create beside the file it was opened from, at that file's depth", () => {
    const projected = projectEditRows(rows, createDraft("file", "work", "work/data.csv"));
    expect(projected).toEqual([
      { kind: "entry", row: rows[0] },
      { kind: "entry", row: rows[1] },
      { kind: "editor", indent: 1 },
      { kind: "entry", row: rows[2] },
    ]);
  });

  it("replaces the renamed row in place and leaves siblings alone", () => {
    const projected = projectEditRows(rows, renameDraft({ path: "work/data.csv", isDir: false }));
    expect(projected).toEqual([
      { kind: "entry", row: rows[0] },
      { kind: "editor", indent: 1 },
      { kind: "entry", row: rows[2] },
    ]);
  });

  it("renders no input when the anchor row is not on screen", () => {
    const projected = projectEditRows(rows, createDraft("file", "work/plots", "work/plots"));
    expect(projected).toEqual(rows.map((row) => ({ kind: "entry", row })));
  });

  it("never produces two editor rows", () => {
    for (const draft of [
      createDraft("file", "work", "work"), createDraft("dir", "", null), createDraft("file", "work", "work/data.csv"),
      renameDraft({ path: "work", isDir: true }), renameDraft({ path: "reports", isDir: true }),
    ]) {
      expect(projectEditRows(rows, draft).filter((item) => item.kind === "editor")).toHaveLength(1);
    }
  });

  it("renders no input for a rename whose entry is not on screen", () => {
    expect(projectEditRows(rows, renameDraft({ path: "away", isDir: false }))).toEqual(rows.map((row) => ({ kind: "entry", row })));
  });
});
