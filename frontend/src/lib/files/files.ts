/** File I/O adapter — REST-based replacement for open-science's Tauri artifactFile.ts.
 *  Same API surface but calls the FastAPI backend instead of Tauri IPC. */

import type { FileRoot } from "../../types/thread";
import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

export type { FileRoot };

/** Identifies the immutable content revision represented by a preview. */
export type ArtifactContentKey = string | number;

const API = "/api";
const SHA256_RE = /^[0-9a-f]{64}$/i;

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
  contentKey?: ArtifactContentKey,
) => ["artifact-file", cwd, root ?? null, path, maxBytes ?? null, contentKey ?? null] as const;

function immutableArtifactHash(contentKey?: ArtifactContentKey): string | undefined {
  return typeof contentKey === "string" && SHA256_RE.test(contentKey) ? contentKey.toLowerCase() : undefined;
}

function artifactFileQuery(
  path: string,
  root: FileRoot | undefined,
  cwd: string,
  maxBytes?: number,
  contentKey?: ArtifactContentKey,
) {
  const params = new URLSearchParams({ cwd });
  if (root) params.set("root", root);
  if (maxBytes !== undefined) params.set("maxBytes", String(maxBytes));
  const artifactHash = immutableArtifactHash(contentKey);
  if (artifactHash && (root === undefined || root === "workspace")) params.set("path", path);
  return {
    queryKey: artifactFileKey(cwd, path, root, maxBytes, contentKey),
    queryFn: () => apiRequest<ArtifactFile>(artifactHash && (root === undefined || root === "workspace")
      ? `${API}/artifacts/content/${artifactHash}?${params}`
      : `${API}/files/${encodeWorkspacePath(path)}?${params}`),
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
 *  first N bytes (used by per-turn artifact cards to preview file content).
 *
 * A SHA-256 `contentKey` uses the immutable artifact-content endpoint; legacy
 * numeric revisions remain cache identities only. */
export async function readArtifact(
  path: string,
  root: FileRoot | undefined,
  cwd: string,
  maxBytes?: number,
  contentKey?: ArtifactContentKey,
): Promise<ArtifactFile | null> {
  try {
    return await queryClient.fetchQuery(artifactFileQuery(path, root, cwd, maxBytes, contentKey));
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
export function previewUrl(
  path: string,
  root: FileRoot | undefined,
  cwd: string,
  contentKey?: ArtifactContentKey,
): string {
  const artifactHash = immutableArtifactHash(contentKey);
  if (artifactHash && (root === undefined || root === "workspace")) {
    const params = new URLSearchParams({ cwd, path });
    return `${API}/artifacts/content/${artifactHash}/serve?${params}`;
  }
  const params = new URLSearchParams({ cwd });
  if (root) params.set("root", root);
  // Non-hash revisions still bust the browser cache for legacy artifacts.
  if (contentKey !== undefined) params.set("v", String(contentKey));
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
