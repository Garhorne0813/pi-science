import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { appendJsonLine, metadataRoot, workspaceFile } from "../storage/persistence.js";
import { publishWorkspaceArtifacts } from "../runtime/artifacts/workspace-artifact-publisher.js";
import { resolveWorkspaceFile, validateWorkspaceCwd } from "./workspace-security.js";
import { recordEgress } from "./egress-audit.js";
import { fetchDownloadHop, parseDownloadUrl } from "./download-egress.js";

const MAX_BYTES = 256 * 1024 * 1024;
const grants = new Map<string, number>();

export class NetworkAccessRequired extends Error {
  readonly code = "network_access_required";
  constructor(readonly host: string) { super(`Network access to ${host} requires approval`); }
}

function grantKey(workspace: string, session: string, host: string): string { return `${workspace}\0${session}\0${host}`; }

export async function grantDownloadHost(workspace: string, session: string, rawUrl: string): Promise<{ host: string; expiresAt: string }> {
  if (!session) throw new Error("session_id is required");
  workspace = await validateWorkspaceCwd(workspace);
  const host = parseDownloadUrl(rawUrl).hostname.toLowerCase();
  const expiresAt = Date.now() + 60 * 60_000;
  grants.set(grantKey(workspace, session, host), expiresAt);
  return { host, expiresAt: new Date(expiresAt).toISOString() };
}

function hasGrant(workspace: string, session: string, host: string): boolean {
  const key = grantKey(workspace, session, host);
  const expiresAt = grants.get(key) ?? 0;
  if (expiresAt <= Date.now()) { grants.delete(key); return false; }
  return true;
}

async function safeDestination(workspace: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).some((part) => part === "..")) throw new Error("destination must be a workspace-relative path");
  const lexicalTarget = resolve(workspace, path);
  let lexical = workspace;
  for (const part of relative(workspace, lexicalTarget).split(sep)) {
    lexical = resolve(lexical, part);
    try { if ((await lstat(lexical)).isSymbolicLink()) throw new Error("destination may not contain symlinks"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const target = await resolveWorkspaceFile(workspace, path);
  const rel = relative(workspace, target);
  if (!rel || rel.startsWith(`..${sep}`)) throw new Error("destination must be inside the workspace");
  let current = workspace;
  const parts = rel.split(sep);
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    if (!(await lstat(current)).isDirectory()) throw new Error("destination parent must be a directory without symlinks");
  }
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error("destination may not be a symlink"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return target;
}

export async function downloadUrl(input: { workspace: string; sessionId: string; url: string; destination: string; expectedSha256?: string; maxBytes?: number; signal?: AbortSignal; proxyUrl?: string; validateFile?: (path: string) => Promise<void> }) {
  const workspace = await validateWorkspaceCwd(input.workspace);
  const cap = input.maxBytes ?? MAX_BYTES;
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_BYTES) throw new Error(`max_bytes must be between 1 and ${MAX_BYTES}`);
  if (input.expectedSha256 && !/^[a-f0-9]{64}$/i.test(input.expectedSha256)) throw new Error("expected_sha256 must be 64 hex characters");
  // Validate before connecting; create directories only after authorization and
  // a successful response so a denied request leaves the workspace untouched.
  const target = await resolveWorkspaceFile(workspace, input.destination);
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(60_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline, controller.signal]) : AbortSignal.any([deadline, controller.signal]);
  let current = parseDownloadUrl(input.url);
  const redirects: string[] = [];
  let response: Awaited<ReturnType<typeof fetchDownloadHop>>;
  try {
    for (let hop = 0; ; hop += 1) {
      if (!hasGrant(workspace, input.sessionId, current.hostname.toLowerCase())) {
        await recordEgress({ connector_type: "download", connector_id: input.sessionId, target_domain: current.href, approved: false, note: "approval_required" });
        throw new NetworkAccessRequired(current.hostname);
      }
      await recordEgress({ connector_type: "download", connector_id: input.sessionId, target_domain: current.href, approved: true, note: "download_request" });
      response = await fetchDownloadHop(current, signal, input.proxyUrl);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        if (hop >= 5) throw new Error("download has too many redirects");
        redirects.push(current.href);
        current = parseDownloadUrl(new URL(location, current).href);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`download failed: HTTP ${response.status}`); }
      break;
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > cap) { await response.body?.cancel(); throw new Error("download exceeds size limit"); }
    if (!response.body) throw new Error("download response has no body");
    await safeDestination(workspace, input.destination);
    const temp = resolve(dirname(target), `.pi-science-download-${randomUUID()}.tmp`);
    const hash = createHash("sha256");
    let size = 0;
    try {
      await pipeline(Readable.fromWeb(response.body as any), new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > cap) return callback(new Error("download exceeds size limit"));
        hash.update(chunk);
        callback(null, chunk);
      } }), createWriteStream(temp, { flags: "wx", mode: 0o600 }), { signal });
      if (!size) throw new Error("download response is empty");
      const sha256 = hash.digest("hex");
      if (input.expectedSha256 && sha256 !== input.expectedSha256.toLowerCase()) throw new Error("download SHA-256 mismatch");
      await input.validateFile?.(temp);
      // Recheck the path after the network operation before publishing bytes.
      if (await safeDestination(workspace, input.destination) !== target) throw new Error("destination changed during download");
      await rename(temp, target);
      await mkdir(metadataRoot(workspace), { recursive: true });
      const [artifact] = await publishWorkspaceArtifacts(workspace, [input.destination], { tool: "download_url", sessionId: input.sessionId, source: current.href, inputs: [{ requested_url: input.url, final_url: current.href, redirects, retrieved_at: new Date().toISOString(), sha256, size, content_type: response.headers.get("content-type"), etag: response.headers.get("etag"), last_modified: response.headers.get("last-modified") }] });
      if (!artifact) throw new Error("downloaded file could not be published as an artifact");
      const receipt = { requested_url: input.url, final_url: current.href, redirects, destination: input.destination, size, sha256, artifact_id: artifact?.artifact_id, artifact_version: artifact?.version, content_type: response.headers.get("content-type"), etag: response.headers.get("etag"), last_modified: response.headers.get("last-modified"), retrieved_at: new Date().toISOString() };
      await appendJsonLine(workspaceFile(workspace, "download-receipts.jsonl"), receipt);
      return receipt;
    } finally { await rm(temp, { force: true }); }
  } finally { controller.abort(); }
}
