import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { metadataRoot } from "../../storage/persistence.js";

export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

export interface ArtifactBlob { sha256: string; size: number }

export function artifactBlobPath(cwd: string, sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error("Invalid artifact blob digest");
  return join(metadataRoot(cwd), "artifact-blobs", sha256.slice(0, 2), sha256);
}

function isContained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function openArtifactSource(sourceRoot: string, source: string) {
  const root = await realpath(sourceRoot);
  const target = resolve(source);
  if (!isContained(root, target) || target === root) throw new Error("Artifact source escapes the workspace");

  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Artifact source must not be a symbolic link");
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new Error("Artifact source must be a regular file");

    let current = root;
    for (const part of relative(root, target).split(/[\\/]/)) {
      current = join(current, part);
      const info = await lstat(current, { bigint: true });
      if (info.isSymbolicLink()) throw new Error("Artifact source must not contain symbolic links");
      if (current === target && (!info.isFile() || info.dev !== opened.dev || info.ino !== opened.ino)) {
        throw new Error("Artifact source changed while it was being opened");
      }
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Capture the bytes once, before publishing metadata. A changed source file
 * cannot cause the manifest digest to describe a different saved version. */
export async function captureArtifactBlob(cwd: string, source: string, sourceRoot = cwd): Promise<ArtifactBlob> {
  const sourceHandle = await openArtifactSource(sourceRoot, source);
  const root = join(metadataRoot(cwd), "artifact-blobs");
  let temporary: string | undefined;
  try {
    await assertRealDirectory(metadataRoot(cwd));
    await mkdir(root, { recursive: true });
    await assertRealDirectory(root);
    temporary = join(root, `.capture-${randomUUID()}.tmp`);
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(
      sourceHandle.createReadStream({ autoClose: false }),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > MAX_ARTIFACT_BYTES) return callback(new Error("artifact is too large to publish"));
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    const sha256 = hash.digest("hex");
    const destination = artifactBlobPath(cwd, sha256);
    await mkdir(join(root, sha256.slice(0, 2)), { recursive: true });
    await assertRealDirectory(join(root, sha256.slice(0, 2)));
    await chmod(temporary, 0o400);
    try { await link(temporary, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await verifyArtifactBlob(cwd, { sha256, size });
      if (!existing.valid) throw new Error("Existing artifact blob failed verification");
    }
    return { sha256, size };
  } finally {
    await sourceHandle.close();
    if (temporary) await unlink(temporary).catch(() => undefined);
  }
}

export async function verifyArtifactBlob(cwd: string, expected: ArtifactBlob): Promise<ArtifactBlob & { valid: boolean }> {
  const path = artifactBlobPath(cwd, expected.sha256);
  await assertRealDirectory(metadataRoot(cwd));
  await assertRealDirectory(join(metadataRoot(cwd), "artifact-blobs"));
  await assertRealDirectory(join(metadataRoot(cwd), "artifact-blobs", expected.sha256.slice(0, 2)));
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Artifact blob is not a regular file");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) { size += chunk.length; hash.update(chunk); }
  const sha256 = hash.digest("hex");
  return { sha256, size, valid: sha256 === expected.sha256 && size === expected.size };
}

async function assertRealDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Artifact store directory is not a regular directory");
}
