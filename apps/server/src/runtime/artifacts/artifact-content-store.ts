import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, link, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isArtifactSurfaceablePath } from "./artifact-surface-policy.js";
import { metadataRoot, readJsonLines, workspaceFile } from "../../storage/persistence.js";
import { resolveWorkspaceFile, validateWorkspaceCwd } from "../../security/workspace-security.js";

interface ArtifactContentManifest {
  path?: string;
  sha256?: string;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function normalizeArtifactPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === "..") || !isArtifactSurfaceablePath(normalized)) {
    throw new Error("Artifact path is not available for automatic preview");
  }
  return normalized;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function artifactContentDirectory(cwd: string): Promise<string> {
  const root = metadataRoot(cwd);
  await mkdir(root, { recursive: true });
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new Error("Workspace .pi-science directory must not be a symbolic link");
  const directory = join(root, "artifact-content");
  await mkdir(directory, { recursive: true });
  const directoryInfo = await lstat(directory);
  if (directoryInfo.isSymbolicLink()) throw new Error("Artifact content directory must not be a symbolic link");
  return directory;
}

async function existingSnapshotValid(path: string, expectedSha256: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Artifact content snapshot must be a regular file");
    if (await sha256File(path) !== expectedSha256) throw new Error("Artifact content snapshot hash mismatch");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function installSnapshot(directory: string, temporary: string, sha256: string): Promise<void> {
  const destination = join(directory, sha256);
  if (await existingSnapshotValid(destination, sha256)) return;
  try {
    await link(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await existingSnapshotValid(destination, sha256);
  }
}

export async function persistArtifactFile(cwd: string, sourcePath: string, expectedSha256: string): Promise<void> {
  const sha256 = expectedSha256.toLowerCase();
  if (!SHA256_RE.test(sha256)) throw new Error("Invalid artifact SHA-256");
  const directory = await artifactContentDirectory(cwd);
  const destination = join(directory, sha256);
  if (await existingSnapshotValid(destination, sha256)) return;
  const temporary = join(directory, `.${sha256}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await copyFile(sourcePath, temporary);
    if (await sha256File(temporary) !== sha256) throw new Error("Artifact changed while its immutable content was being captured");
    await installSnapshot(directory, temporary, sha256);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function persistArtifactBytes(cwd: string, expectedSha256: string, bytes: Buffer): Promise<void> {
  const sha256 = expectedSha256.toLowerCase();
  if (!SHA256_RE.test(sha256)) throw new Error("Invalid artifact SHA-256");
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Artifact bytes do not match their SHA-256");
  const directory = await artifactContentDirectory(cwd);
  const destination = join(directory, sha256);
  if (await existingSnapshotValid(destination, sha256)) return;
  const temporary = join(directory, `.${sha256}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await installSnapshot(directory, temporary, sha256);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Resolve an immutable published artifact body. For manifests created before
 * snapshot storage existed, the current workspace file is used only when its
 * bytes still match the requested hash; stale content is never substituted. */
export async function resolveArtifactContent(cwd: string, requestedPath: string, expectedSha256: string): Promise<{ file: string; path: string }> {
  const sha256 = expectedSha256.toLowerCase();
  if (!SHA256_RE.test(sha256)) throw new Error("Invalid artifact SHA-256");
  const workspace = await validateWorkspaceCwd(cwd);
  const path = normalizeArtifactPath(requestedPath);
  const manifests = await readJsonLines<ArtifactContentManifest>(workspaceFile(workspace, "artifacts.jsonl"));
  if (!manifests.some((item) => item.path === path && item.sha256?.toLowerCase() === sha256)) {
    throw new Error("Artifact content hash is not published for this path");
  }

  const snapshot = join(metadataRoot(workspace), "artifact-content", sha256);
  if (await existingSnapshotValid(snapshot, sha256)) return { file: snapshot, path };

  // Legacy fallback: preserve correctness rather than returning whatever now
  // happens to occupy the path. Reject lexical symlinks and verify the bytes.
  let lexical = workspace;
  for (const part of path.split("/")) {
    lexical = join(lexical, part);
    const info = await lstat(lexical);
    if (info.isSymbolicLink()) throw new Error("Symlinks are not available for automatic artifact preview");
  }
  const current = await resolveWorkspaceFile(workspace, path);
  const currentInfo = await lstat(current);
  if (!currentInfo.isFile() || await sha256File(current) !== sha256) {
    throw new Error("Immutable content for this artifact version is unavailable");
  }
  return { file: current, path };
}
