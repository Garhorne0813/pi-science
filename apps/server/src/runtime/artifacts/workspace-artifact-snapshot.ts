import { lstat, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { isArtifactSurfaceablePath } from "./artifact-surface-policy.js";

/** Bounded workspace snapshot for turn-level artifact detection.
 *
 *  At `agent_start` the service records a baseline; at `agent_settled` it
 *  re-scans and diffs the two snapshots so files created/modified by the turn
 *  (bash/Python runs, scripts, downloads) become preview cards even when no
 *  explicit artifact publication happened. The scan is deliberately bounded:
 *  shallow depth, artifact/node caps, ignored dependency/cache/hidden directories,
 *  and oversized files dropped, so a large workspace never stalls a turn. */

export interface WorkspaceSnapshotEntry {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export const MAX_SNAPSHOT_ENTRIES = 10_000;
export const MAX_SNAPSHOT_VISITED_NODES = 50_000;
export const MAX_SNAPSHOT_DEPTH = 3;
export const MAX_SNAPSHOT_FILE_BYTES = 100 * 1024 * 1024;

/** Artifact-candidate cap, overridable via PI_SCIENCE_SNAPSHOT_CAP.
 *  Read per call so tests can shrink it without module re-import. */
export function snapshotEntryCap(): number {
  const value = Number(process.env.PI_SCIENCE_SNAPSHOT_CAP ?? 0);
  return Number.isInteger(value) && value > 0 ? value : MAX_SNAPSHOT_ENTRIES;
}

/** Total directory entries inspected during a snapshot. Unlike the artifact
 * cap, this bounds all directories, symlinks, sensitive files and unknown
 * formats, so non-artifact workspace content cannot make the walk unbounded. */
export function snapshotNodeCap(): number {
  const value = Number(process.env.PI_SCIENCE_SNAPSHOT_NODE_CAP ?? 0);
  return Number.isInteger(value) && value > 0 ? value : MAX_SNAPSHOT_VISITED_NODES;
}

const IGNORED_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", ".venv", "venv", ".pi-science", ".pi",
  ".cache", "dist", "build", "out", "target", ".next", ".turbo",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox",
  ".ipynb_checkpoints", ".idea", ".vscode", ".eggs", "htmlcov", ".coverage",
  ".parquet-cache", ".mpl-config", ".jupyter",
]);

function isIgnoredDir(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (IGNORED_DIRS.has(name)) return true;
  return name.endsWith(".egg-info");
}

/** Whether a file could surface with a rich preview rather than a generic card. */
export function isPreviewableFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  if (!ext) return false;
  const previewable = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".tif", ".tiff",
    ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".parquet", ".xlsx", ".xls",
    ".txt", ".md", ".html", ".htm", ".pdf", ".docx", ".pptx", ".rtf",
    ".py", ".r", ".ipynb", ".sh", ".jl", ".m",
    ".pdb", ".cif", ".mcif", ".mmcif", ".mol", ".sdf", ".xyz",
  ]);
  return previewable.has(ext);
}

/** Coarse artifact kind for a snapshot file (mirrors node-event-observer). */
export function previewKind(path: string): string {
  const ext = extname(path).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".tif", ".tiff"].includes(ext)) return "image";
  if ([".csv", ".tsv", ".xlsx", ".xls", ".parquet"].includes(ext)) return "table";
  if ([".pdf", ".docx", ".pptx", ".rtf"].includes(ext)) return "document";
  if ([".ipynb"].includes(ext)) return "notebook";
  if ([".pdb", ".cif", ".mcif", ".mmcif", ".mol", ".sdf", ".xyz"].includes(ext)) return "structure";
  if ([".py", ".r", ".sh", ".jl", ".m"].includes(ext)) return "code";
  if ([".txt", ".md", ".html", ".htm", ".json", ".yaml", ".yml", ".xml"].includes(ext)) return "text";
  return "file";
}

/** Lightweight MIME guess for snapshot files. */
export function previewMime(path: string): string {
  const table: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".svg": "image/svg+xml", ".webp": "image/webp", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
    ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".json": "application/json",
    ".yaml": "text/yaml", ".yml": "text/yaml", ".xml": "text/xml", ".parquet": "application/octet-stream",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel", ".txt": "text/plain", ".md": "text/markdown",
    ".html": "text/html", ".htm": "text/html", ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".rtf": "application/rtf", ".py": "text/x-python", ".r": "text/x-r-source",
    ".sh": "text/x-shellscript", ".jl": "text/x-julia", ".m": "text/x-matlab",
    ".ipynb": "application/x-ipynb+json", ".pdb": "chemical/x-pdb", ".cif": "chemical/x-cif",
    ".mcif": "chemical/x-cif", ".mmcif": "chemical/x-cif",
    ".mol": "chemical/x-mdl-molfile", ".sdf": "chemical/x-mdl-sdfile", ".xyz": "chemical/x-xyz",
  };
  return table[extname(path).toLowerCase()] ?? "application/octet-stream";
}

type WalkState = {
  entryCap: number;
  nodeCap: number;
  visited: number;
  truncated: boolean;
};

function reserveNode(state: WalkState): boolean {
  if (state.visited >= state.nodeCap) {
    state.truncated = true;
    return false;
  }
  state.visited += 1;
  return true;
}

function addEntry(entries: WorkspaceSnapshotEntry[], state: WalkState, entry: WorkspaceSnapshotEntry): boolean {
  if (entries.length >= state.entryCap) {
    state.truncated = true;
    return false;
  }
  entries.push(entry);
  return true;
}

async function walk(root: string, dir: string, depth: number, entries: WorkspaceSnapshotEntry[], state: WalkState): Promise<void> {
  if (depth > MAX_SNAPSHOT_DEPTH || state.truncated) return;
  let names: string[];
  try {
    names = (await readdir(dir)).sort((left, right) => left.localeCompare(right));
  } catch {
    return;
  }
  for (const name of names) {
    if (!reserveNode(state)) return;
    if (isIgnoredDir(name)) continue;
    const absolute = join(dir, name);
    let info;
    try {
      info = await lstat(absolute);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await walk(root, absolute, depth + 1, entries, state);
      if (state.truncated) return;
      continue;
    }
    if (!info.isFile() || info.size > MAX_SNAPSHOT_FILE_BYTES) continue;
    const path = relative(root, absolute).replaceAll("\\", "/");
    if (!isArtifactSurfaceablePath(path) || !isPreviewableFile(path)) continue;
    if (!addEntry(entries, state, { path, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs })) return;
  }
}

/** Bounded snapshot of artifact candidates. Every non-ignored directory is
 * walked up to the depth/node caps, but only previewable, surfaceable files
 * consume the artifact entry cap. This keeps ordinary source/data trees from
 * disabling generated-file detection while still bounding memory and I/O.
 * If either cap is exceeded, return `null` rather than diffing incomplete
 * subsets and risking false "created" artifacts. */
export async function snapshotWorkspace(cwd: string): Promise<WorkspaceSnapshotEntry[] | null> {
  const root = resolve(cwd);
  let names: string[];
  try {
    names = (await readdir(root)).sort((left, right) => left.localeCompare(right));
  } catch {
    return null;
  }
  const entries: WorkspaceSnapshotEntry[] = [];
  const state: WalkState = { entryCap: snapshotEntryCap(), nodeCap: snapshotNodeCap(), visited: 0, truncated: false };
  for (const name of names) {
    if (!reserveNode(state)) break;
    if (isIgnoredDir(name)) continue;
    const absolute = join(root, name);
    let info;
    try {
      info = await lstat(absolute);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await walk(root, absolute, 1, entries, state);
      if (state.truncated) break;
      continue;
    }
    if (!info.isFile() || info.size > MAX_SNAPSHOT_FILE_BYTES) continue;
    const path = relative(root, absolute).replaceAll("\\", "/");
    if (!isArtifactSurfaceablePath(path) || !isPreviewableFile(path)) continue;
    if (!addEntry(entries, state, { path, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs })) break;
  }
  return state.truncated ? null : entries;
}

export interface WorkspaceDiff {
  created: WorkspaceSnapshotEntry[];
  modified: WorkspaceSnapshotEntry[];
}

/** Entries present after but not before → created; same path with a newer
 *  mtime or different size → modified. Ordered by mtime (newest first). */
export function diffWorkspaceSnapshots(before: WorkspaceSnapshotEntry[] | null, after: WorkspaceSnapshotEntry[]): WorkspaceDiff {
  if (!before) return { created: [], modified: [] };
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const created: WorkspaceSnapshotEntry[] = [];
  const modified: WorkspaceSnapshotEntry[] = [];
  for (const entry of after) {
    const previous = beforeByPath.get(entry.path);
    if (!previous) {
      created.push(entry);
    } else if (previous.size !== entry.size || previous.mtimeMs !== entry.mtimeMs) {
      modified.push(entry);
    }
  }
  const byMtime = (a: WorkspaceSnapshotEntry, b: WorkspaceSnapshotEntry) => b.mtimeMs - a.mtimeMs;
  created.sort(byMtime);
  modified.sort(byMtime);
  return { created, modified };
}
