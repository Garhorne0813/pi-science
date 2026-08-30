// Immutable output writer for scheduled-task attempts (docs §9.10): every
// Attempt owns its directory and files are published with the strict sequence
// temp(0600) → fsync → assert target absent → rename, so a retry can never
// rewrite a sibling Attempt's evidence and an existing target is a hard
// OUTPUT_EXISTS failure. Windows may ignore the POSIX mode, but containment
// and no-overwrite still hold.
import { randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { lstat, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/** Error code surfaced when an immutable target already exists (docs §14.2 Output row). */
export const OUTPUT_EXISTS = "OUTPUT_EXISTS";

export class OutputExistsError extends Error {
  readonly code = OUTPUT_EXISTS;
  constructor(path: string) {
    super(`immutable output already exists: ${path}`);
    this.name = "OutputExistsError";
  }
}

/** Pi-Science managed metadata directory; scheduled outputs must never live inside it. */
const FORBIDDEN_SEGMENTS = new Set([".pi-science"]);

function containsForbiddenSegment(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => FORBIDDEN_SEGMENTS.has(segment));
}

/** Lexical safety for workspace-relative output paths (docs §14.2 Security row):
 * absolute paths, `..` traversal and `.pi-science` components are rejected. */
export function isSafeRelativeOutputPath(value: string): boolean {
  if (!value || value.trim() === "" || value.includes("\0")) return false;
  if (isAbsolute(value)) return false;
  if (containsForbiddenSegment(value)) return false;
  return value.split(/[\\/]/).every((segment) => segment !== "..");
}

/** Resolve `relativePath` under `baseDir`, rejecting any lexical escape
 * (absolute input, `..` segments, managed `.pi-science` components). */
export function resolveInside(baseDir: string, relativePath: string): string {
  if (!isSafeRelativeOutputPath(relativePath)) throw new Error(`unsafe output path rejected: ${JSON.stringify(relativePath)}`);
  const target = resolve(baseDir, relativePath);
  const rel = relative(resolve(baseDir), target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`output path escapes its base directory: ${relativePath}`);
  return target;
}

// In-process per-target serialization so concurrent writers of one immutable
// file are ordered deterministically: exactly one publishes, the losers see
// the published target and fail with OUTPUT_EXISTS. Cross-process exclusion
// comes from the layout itself — each Attempt owns a unique directory.
const targetLocks = new Map<string, Promise<unknown>>();

async function withTargetLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(target);
  const previous = targetLocks.get(key) ?? Promise.resolve();
  // Run regardless of the predecessor's outcome; failures must not poison the chain.
  const result = previous.then(operation, operation);
  const tracked = result.then(
    () => undefined,
    () => undefined,
  );
  targetLocks.set(key, tracked);
  void tracked.then(() => {
    if (targetLocks.get(key) === tracked) targetLocks.delete(key);
  });
  return result;
}

/** Create the attempt output directory (`root`) recursively; returns the absolute path. */
export async function ensureAttemptOutputDir(root: string): Promise<string> {
  const resolved = resolve(root);
  if (containsForbiddenSegment(resolved)) throw new Error(`output root traverses managed metadata directory: ${root}`);
  await mkdir(resolved, { recursive: true });
  return resolved;
}

/**
 * Publish `content` as an immutable file named `name` inside `dir`.
 * Sequence (docs §9.10): create temp sibling with mode 0600 → write → fsync →
 * assert the final target does not exist → rename temp over target.
 * Throws OutputExistsError when the target exists; never truncates or rewrites it.
 */
export async function writeImmutableFile(dir: string, name: string, content: string): Promise<string> {
  const safeDir = resolve(dir);
  if (containsForbiddenSegment(safeDir)) throw new Error(`immutable output directory traverses managed metadata directory: ${dir}`);
  const target = resolveInside(safeDir, name);
  return withTargetLock(target, () => publishImmutable(target, content));
}

async function publishImmutable(target: string, content: string): Promise<string> {
  await mkdir(dirname(target), { recursive: true });
  // Fast-fail before doing any work; re-asserted after fsync to narrow the window.
  await assertAbsent(target);
  const temporary = joinPath(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
  try {
    await assertAbsent(target);
    await rename(temporary, target);
    return target;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function assertAbsent(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch {
    return; // ENOENT — the only acceptable state.
  }
  throw new OutputExistsError(target);
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}
