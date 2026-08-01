/** File I/O adapter — REST-based replacement for open-science's Tauri artifactFile.ts.
 *  Same API surface but calls the FastAPI backend instead of Tauri IPC. */

import type { FileRoot } from "../../types/thread";
import { apiRequest } from "../client/api";

export type { FileRoot };

const API = "/api";

export interface ArtifactFile {
  path: string;
  mime: string;
  encoding: "utf8" | "base64";
  data: string;
  size: number;
}

/** Read a workspace file. Uses REST API. */
export async function readArtifact(
  path: string,
  root: FileRoot | undefined,
  cwd: string,
): Promise<ArtifactFile | null> {
  try {
    const params = new URLSearchParams({ cwd });
    if (root) params.set("root", root);
    return await apiRequest<ArtifactFile>(`${API}/files/${encodeURIComponent(path)}?${params}`);
  } catch {
    return null;
  }
}

/** Overwrite a workspace text file with new content. Uses REST API. */
export async function writeArtifact(
  path: string,
  root: FileRoot | undefined,
  cwd: string,
  content: string,
): Promise<{ ok: boolean; path: string; size: number }> {
  const params = new URLSearchParams({ cwd });
  if (root) params.set("root", root);
  return apiRequest<{ ok: boolean; path: string; size: number }>(`${API}/files/content?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
}

/** URL for browser-native preview (PDF, images, HTML, video).
 *  Uses /serve/ instead of /{path}/raw so relative references
 *  (CSS, JS, images) in HTML resolve back to the same prefix.
 *  Each path segment is encoded individually so / separators stay
 *  literal — otherwise the browser sees %2F as part of a single
 *  filename and relative resolution breaks. */
export function previewUrl(path: string, root: FileRoot | undefined, cwd: string): string {
  const params = new URLSearchParams({ cwd });
  if (root) params.set("root", root);
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${API}/files/serve/${encodedPath}?${params}`;
}

/** Open a file in the OS default app — web fallback: open in new tab.
 *  serve URLs are excluded because the right-side inspector previews them inline. */
export async function openArtifactExternally(
  path: string,
  root: FileRoot | undefined,
  cwd: string,
): Promise<void> {
  const url = previewUrl(path, root, cwd);
  if (url.includes("/api/files/serve/")) return;
  window.open(url, "_blank");
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
  root: FileRoot | undefined,
  cwd: string,
): Promise<LargeFilePointer | null> {
  try {
    const params = new URLSearchParams({ cwd });
    if (root) params.set("root", root);
    return await apiRequest<LargeFilePointer>(`${API}/files/probe/${encodeURIComponent(path)}?${params}`);
  } catch {
    return null;
  }
}
