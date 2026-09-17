import { copyFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { metadataRoot } from "../../storage/persistence.js";

export async function snapshotArtifactVersion(cwd: string, source: string, artifactId: string, version: number, sha256: string): Promise<string> {
  const extension = extname(source).slice(0, 16);
  const root = metadataRoot(cwd);
  const target = join(root, "artifact-versions", artifactId, `v${version}-${sha256}${extension}`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await copyFile(source, temporary);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(temporary)) hash.update(chunk);
    if (hash.digest("hex") !== sha256) throw Object.assign(new Error("Artifact changed while its immutable version was being captured"), { code: "artifact_changed_during_publish" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return relative(root, target).replaceAll("\\", "/");
}

export async function snapshotArtifactVersionBytes(cwd: string, sourceName: string, bytes: Uint8Array, artifactId: string, version: number, sha256: string): Promise<string> {
  const extension = extname(sourceName).slice(0, 16);
  const root = metadataRoot(cwd);
  const target = join(root, "artifact-versions", artifactId, `v${version}-${sha256}${extension}`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return relative(root, target).replaceAll("\\", "/");
}

export function resolveArtifactVersionPath(cwd: string, snapshotPath: string): string {
  const root = resolve(metadataRoot(cwd));
  const target = resolve(root, snapshotPath);
  if (target === root || !target.startsWith(`${root}${sep}`) || !snapshotPath.replaceAll("\\", "/").startsWith("artifact-versions/")) {
    throw new Error(`Invalid artifact snapshot path: ${basename(snapshotPath)}`);
  }
  return target;
}
