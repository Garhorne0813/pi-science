export type FileKind = "file" | "dir";

/** What the inline name input is doing. `dir` is where a create lands; a rename
 *  targets the entry's own path. `anchor` is the row the input renders after,
 *  or null when it renders above the whole list. */
export type InlineFileEdit =
  | { mode: "create"; kind: FileKind; dir: string; anchor: string | null }
  | { mode: "rename"; kind: FileKind; path: string };

export type InlineEditError = "conflict" | "invalid" | "request";

/** A surface's whole inline-edit state. One draft at a time, so no combination
 *  of booleans can leave two inputs on screen. */
export interface InlineEditDraft {
  edit: InlineFileEdit;
  value: string;
  saving: boolean;
  error: InlineEditError | null;
}

export type FileMutation =
  | { kind: "create-file"; target: string }
  | { kind: "create-folder"; target: string }
  | { kind: "rename"; source: string; target: string; isDir: boolean };

export type CommitPlan =
  | { kind: "cancel" }
  | { kind: "unchanged" }
  | { kind: "invalid" }
  | { kind: "mutation"; mutation: FileMutation };

/** The rows a surface renders: its own entry rows with exactly one editor row
 *  spliced in, so the position rule lives in one place for both surfaces. */
export type EditRow<T> = { kind: "entry"; row: T } | { kind: "editor"; indent: number };

export function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function createEdit(kind: FileKind, dir: string, anchor: string | null): InlineFileEdit {
  return { mode: "create", kind, dir, anchor };
}

export function renameEdit(entry: { path: string; isDir: boolean }): InlineFileEdit {
  return { mode: "rename", kind: entry.isDir ? "dir" : "file", path: entry.path };
}

export function createDraft(kind: FileKind, dir: string, anchor: string | null): InlineEditDraft {
  return { edit: createEdit(kind, dir, anchor), value: "", saving: false, error: null };
}

export function renameDraft(entry: { path: string; isDir: boolean }): InlineEditDraft {
  return { edit: renameEdit(entry), value: baseName(entry.path), saving: false, error: null };
}

/** Workspace-relative path the edit produces. A blank name yields "" so callers
 *  can treat it as a no-op instead of creating an entry named "". */
export function targetPath(edit: InlineFileEdit, name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  const dir = edit.mode === "create" ? edit.dir : parentDir(edit.path);
  return dir ? `${dir}/${trimmed}` : trimmed;
}

export function isNameValid(name: string): boolean {
  const trimmed = name.trim();
  return trimmed !== "" && trimmed !== "." && trimmed !== ".." && !/[/\\]/.test(trimmed);
}

export function planCommit(draft: InlineEditDraft): CommitPlan {
  const name = draft.value.trim();
  const edit = draft.edit;
  if (edit.mode === "rename") {
    // Renaming an entry to the name it already has must never reach the server:
    // the rename route answers 409 for an existing target.
    if (name === baseName(edit.path)) return { kind: "unchanged" };
  } else if (!name) {
    return { kind: "cancel" };
  }
  if (!isNameValid(name)) return { kind: "invalid" };
  const target = targetPath(edit, name);
  if (edit.mode === "create") {
    return { kind: "mutation", mutation: { kind: edit.kind === "dir" ? "create-folder" : "create-file", target } };
  }
  return { kind: "mutation", mutation: { kind: "rename", source: edit.path, target, isDir: edit.kind === "dir" } };
}

/** Classify a thrown mutation error without importing the transport: a 409 is a
 *  name conflict, anything else is a plain request failure. */
export function editErrorFor(error: unknown): InlineEditError {
  return (error as { status?: number } | null)?.status === 409 ? "conflict" : "request";
}

export function projectEditRows<T extends { path: string; depth: number }>(
  rows: readonly T[],
  draft: InlineEditDraft | null,
): EditRow<T>[] {
  if (!draft) return rows.map((row) => ({ kind: "entry", row }));
  const edit = draft.edit;
  if (edit.mode === "rename") {
    return rows.map((row) => (row.path === edit.path ? { kind: "editor", indent: row.depth } : { kind: "entry", row }));
  }
  if (edit.anchor === null) return [{ kind: "editor", indent: 0 }, ...rows.map((row) => ({ kind: "entry" as const, row }))];
  const projected: EditRow<T>[] = [];
  for (const row of rows) {
    projected.push({ kind: "entry", row });
    // A folder anchor that is also the create target takes the input as its first child.
    if (row.path === edit.anchor) projected.push({ kind: "editor", indent: row.depth + (edit.dir === row.path ? 1 : 0) });
  }
  return projected;
}
