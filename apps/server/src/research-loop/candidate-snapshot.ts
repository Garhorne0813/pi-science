import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { CandidateProposal } from "@pi-science/contracts";
import { metadataRoot, writeJsonAtomic } from "../storage/persistence.js";

function safeRelativePath(value: string): string {
  const normalized = normalize(value.replaceAll("\\", "/"));
  if (!value || isAbsolute(value) || normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.split(/[\\/]/).includes("..")) {
    throw new Error(`invalid relative path: ${value}`);
  }
  return normalized;
}

export function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function makeReadOnly(path: string, entrypoint: string, root = path): Promise<void> {
  const info = await stat(path);
  if (info.isDirectory()) {
    for (const name of await readdir(path)) await makeReadOnly(join(path, name), entrypoint, root);
    await chmod(path, 0o555);
  } else {
    await chmod(path, relative(root, path) === entrypoint ? 0o555 : 0o444);
  }
}

export async function snapshotCandidate(cwd: string, loopId: string, proposal: CandidateProposal) {
  const candidateId = `candidate-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const root = join(metadataRoot(cwd), "solutions");
  const destination = join(root, candidateId);
  const temporary = join(root, `.${candidateId}.${process.pid}.tmp`);
  const entrypoint = safeRelativePath(proposal.entrypoint);
  const files = new Map<string, string>();
  let totalBytes = 0;

  for (const [rawPath, content] of Object.entries(proposal.files)) {
    const path = safeRelativePath(rawPath);
    if (path === "solution.json") throw new Error(`reserved candidate path: ${path}`);
    if (files.has(path)) throw new Error(`duplicate candidate path: ${path}`);
    const size = Buffer.byteLength(content, "utf8");
    if (size > 512_000) throw new Error(`candidate file exceeds 512 KB: ${path}`);
    totalBytes += size;
    if (totalBytes > 2_000_000) throw new Error("candidate source exceeds 2 MB");
    files.set(path, content);
  }
  if (!files.has(entrypoint)) throw new Error("entrypoint must be included in candidate files");

  const digest = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    digest.update(path); digest.update("\0"); digest.update(files.get(path)!); digest.update("\0");
  }
  const solutionDigest = `sha256:${digest.digest("hex")}`;

  await mkdir(temporary, { recursive: true });
  try {
    for (const [path, content] of files) {
      const target = join(temporary, path);
      if (!within(temporary, target)) throw new Error(`candidate path escapes snapshot: ${path}`);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, content, { encoding: "utf8", mode: path === entrypoint ? 0o700 : 0o600 });
    }
    const manifest = {
      ...proposal,
      candidate_id: candidateId,
      loop_id: loopId,
      solution: { path: relative(cwd, destination), entrypoint, digest: solutionDigest },
    };
    await writeJsonAtomic(join(temporary, "solution.json"), manifest);
    await rename(temporary, destination);
    await makeReadOnly(destination, entrypoint);
    return manifest;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
