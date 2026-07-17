/** File I/O adapter — REST-based replacement for open-science's Tauri artifactFile.ts.
 *  Same API surface but calls the FastAPI backend instead of Tauri IPC. */

import type { FileRoot } from "../types/thread";

export type { FileRoot };

const API = "/api";

export interface ArtifactFile {
  path: string;
  mime: string;
  encoding: "utf8" | "base64";
  data: string;
  size: number;
}

// Current workspace CWD (set by LiveSessionPage on mount)
let _currentCwd = ".";

export function setCurrentCwd(cwd: string) {
  _currentCwd = cwd;
}

/** Read a workspace file. Uses REST API. */
export async function readArtifact(
  path: string,
  root?: FileRoot,
  cwd?: string,
): Promise<ArtifactFile | null> {
  try {
    const params = new URLSearchParams({ cwd: cwd || _currentCwd });
    if (root) params.set("root", root);
    const res = await fetch(`${API}/files/${encodeURIComponent(path)}?${params}`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/** URL for browser-native preview (PDF, images, HTML, video). */
export function previewUrl(path: string, root?: FileRoot, cwd?: string): string {
  const params = new URLSearchParams({ cwd: cwd || _currentCwd });
  if (root) params.set("root", root);
  return `${API}/files/${encodeURIComponent(path)}/raw?${params}`;
}

/** Open a file in the OS default app — web fallback: open in new tab. */
export async function openArtifactExternally(
  path: string,
  root?: FileRoot,
  cwd?: string,
): Promise<void> {
  const url = previewUrl(path, root, cwd);
  window.open(url, "_blank");
}

/** Download a file through the browser. */
export async function saveWorkspaceFile(path: string, root?: FileRoot, cwd?: string): Promise<void> {
  const url = previewUrl(path, root, cwd);
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").pop() || path;
  a.click();
}

/** Get the absolute path — web fallback: return the path as-is. */
export async function absoluteArtifactPath(
  path: string,
  root?: FileRoot,
): Promise<string | null> {
  void root;
  return path;
}

/** Build a data: URL from artifact data. */
export function toDataUrl(f: ArtifactFile): string {
  if (f.encoding === "base64") {
    return `data:${f.mime};base64,${f.data}`;
  }
  return `data:${f.mime};charset=utf-8,${encodeURIComponent(f.data)}`;
}

/** Decode base64 artifact data to ArrayBuffer for binary viewers. */
export function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export interface DirEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export async function listDir(rel: string, root?: FileRoot, cwd?: string): Promise<DirEntry[]> {
  try {
    const params = new URLSearchParams({ cwd: cwd || _currentCwd });
    if (rel) params.set("subdir", rel);
    if (root) params.set("root", root);
    const res = await fetch(`${API}/files?${params}`);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export interface LargeFilePointer {
  error?: string;
  format?: string;
  size?: string;
  size_bytes?: number;
  note?: string | null;
  hint?: string;
  gzipped?: boolean;
  approx_rows?: number;
  rows?: number;
  num_rows?: number;
  n_rows?: number;
  approx_reads?: number;
  approx_sequences?: number;
  approx_variants?: number;
  n_columns?: number;
  read_length?: { min: number; max: number; mean: number };
  samples?: string[];
  sample_ids?: string[];
  columns?: Array<{ name: string; dtype: string }>;
  datasets?: Array<{ path: string; shape: Array<number | string>; dtype: string }>;
}

export async function probeLargeFile(
  path: string,
  root?: FileRoot,
  cwd?: string,
): Promise<LargeFilePointer | null> {
  try {
    const params = new URLSearchParams({ cwd: cwd || _currentCwd });
    if (root) params.set("root", root);
    const res = await fetch(`${API}/files/probe/${encodeURIComponent(path)}?${params}`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
