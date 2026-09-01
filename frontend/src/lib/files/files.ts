/** File I/O adapter — REST-based replacement for open-science's Tauri artifactFile.ts.
 *  Same API surface but calls the FastAPI backend instead of Tauri IPC. */

import type { FileRoot } from "../../types/thread";
import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

export type { FileRoot };

const API = "/api";

/**
 * File previews are rendered by more than one surface: a turn artifact card,
 * the inspector, and sometimes several cards for the same path. Keep the
 * response in the shared query cache briefly so those surfaces share both
 * in-flight and immediately-following reads instead of opening one request
 * per mounted component.
 */
const ARTIFACT_FILE_STALE_MS = 5_000;
const ARTIFACT_FILE_GC_MS = 30_000;
const ARTIFACT_PROBE_STALE_MS = 30_000;
const ARTIFACT_PROBE_GC_MS = 60_000;
const ARTIFACT_PROBE_CONCURRENCY = 6;
let activeArtifactProbes = 0;
const artifactProbeWaiters: Array<() => void> = [];

async function acquireArtifactProbeSlot(): Promise<void> {
  if (activeArtifactProbes < ARTIFACT_PROBE_CONCURRENCY) {
    activeArtifactProbes += 1;
    return;
  }
  await new Promise<void>((resolve) => artifactProbeWaiters.push(resolve));
}

function releaseArtifactProbeSlot(): void {
  const next = artifactProbeWaiters.shift();
  if (next) {
    // Transfer ownership directly to the oldest waiter. The slot remains
    // counted as active, so a newcomer cannot steal it before the waiter's
    // promise continuation runs.
    next();
    return;
  }
  activeArtifactProbes -= 1;
}

async function withArtifactProbeSlot<T>(run: () => Promise<T>): Promise<T> {
  await acquireArtifactProbeSlot();
  try {
    return await run();
  } finally {
    releaseArtifactProbeSlot();
  }
}

export const artifactFileKey = (
  cwd: string,
  path: string,
  root: FileRoot | undefined,
  maxBytes?: number,
) => ["artifact-file", cwd, root ?? null, path, maxBytes ?? null] as const;

function artifactFileQuery(
  path: string,
  root: FileRoot | undefined,
  cwd: string,
  maxBytes?: number,
) {
  const params = new URLSearchParams({ cwd });
  if (root) params.set("root", root);
  if (maxBytes !== undefined) params.set("maxBytes", String(maxBytes));
  return {
    queryKey: artifactFileKey(cwd, path, root, maxBytes),
    queryFn: () => apiRequest<ArtifactFile>(`${API}/files/${encodeWorkspacePath(path)}?${params}`),
    staleTime: ARTIFACT_FILE_STALE_MS,
    gcTime: ARTIFACT_FILE_GC_MS,
    retry: false,
  };
}

/** Encode a workspace path without hiding separators inside %2F. This keeps
 * wildcard routes and browser/proxy path handling consistent across files. */
function encodeWorkspacePath(path: string): string {
  return path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
}

export interface ArtifactFile {
  path: string;
  mime: string;
  encoding: "utf8" | "base64";
  data: string;
  size: number;
  /** Present when maxBytes was requested and the file is larger than the cap. */
  truncated?: boolean;
}

/** Read a workspace file. Uses REST API. `maxBytes` caps the response to the
 *  first N bytes (used by per-turn artifact cards to preview file content). */
export async function readArtifact(
  path: string,
  root: FileRoot | undefined,
  cwd: string,
  maxBytes?: number,
): Promise<ArtifactFile | null> {
  try {
    return await queryClient.fetchQuery(artifactFileQuery(path, root, cwd, maxBytes));
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
  const result = await apiRequest<{ ok: boolean; path: string; size: number }>(`${API}/files/content?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  await queryClient.invalidateQueries({ queryKey: ["artifact-file", cwd, root ?? null, path] });
  return result;
}

/** URL for browser-native preview (PDF, images, HTML, video). */
export function previewUrl(path: string, root: FileRoot | undefined, cwd: string): string {
  const params = new URLSearchParams({ cwd });
  if (root) params.set("root", root);
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${API}/files/serve/${encodedPath}?${params}`;
}

/** Open a file in the OS default app — web fallback: open in new tab. */
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
  path?: string;
  name?: string;
  size?: string | number;
  size_bytes?: number;
  modified?: number;
  is_dir?: boolean;
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

function artifactProbeQuery(path: string, root: FileRoot | undefined, cwd: string) {
  const params = new URLSearchParams({ cwd });
  if (root) params.set("root", root);
  return {
    queryKey: ["artifact-probe", cwd, root ?? null, path] as const,
    queryFn: () => withArtifactProbeSlot(() => apiRequest<LargeFilePointer>(`${API}/files/probe/${encodeWorkspacePath(path)}?${params}`)),
    staleTime: ARTIFACT_PROBE_STALE_MS,
    gcTime: ARTIFACT_PROBE_GC_MS,
    retry: false,
  };
}

/** Probe metadata/structure without reading the whole file. Calls are shared
 * through the query cache and pass through a module-level semaphore, so many
 * mounted historical turns cannot multiply the effective concurrency. */
export async function probeLargeFile(
  path: string,
  root: FileRoot | undefined,
  cwd: string,
): Promise<LargeFilePointer | null> {
  try {
    return await queryClient.fetchQuery(artifactProbeQuery(path, root, cwd));
  } catch {
    return null;
  }
}
