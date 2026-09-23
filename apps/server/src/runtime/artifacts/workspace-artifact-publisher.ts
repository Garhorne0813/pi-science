import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendJsonLineUnlocked, metadataRoot, readJsonLines, withFileWriteLock, workspaceFile } from "../../storage/persistence.js";
import { resolveWorkspaceFile, validateWorkspaceCwd } from "../../security/workspace-security.js";
import { previewKind, previewMime } from "./workspace-artifact-snapshot.js";
import { captureArtifactBlob } from "./artifact-blob-store.js";
import { artifactIdentity } from "./artifact-identity.js";

interface ArtifactManifest {
  artifact_id: string;
  version: number;
  path: string;
  kind: string;
  mime: string;
  size: number;
  sha256: string;
  blob_sha256?: string;
  published_at: string;
  producer?: Record<string, unknown>;
  inputs?: unknown[];
  environment?: Record<string, unknown>;
  verification?: Record<string, unknown>;
}

export interface PublishedWorkspaceArtifact {
  artifact_id: string;
  version: number;
  path: string;
  sha256: string;
  size: number;
}

export interface PublishWorkspaceArtifactOptions {
  tool: string;
  executionId?: string;
  sessionId?: string | null;
  source?: string;
  notebookPath?: string | null;
  cellId?: string | null;
  kind?: string;
  loopId?: string;
  candidateId?: string;
  runId?: string;
  onFailure?: (failure: WorkspaceArtifactPublishFailure) => void;
}

export interface WorkspaceArtifactPublishFailure {
  path: string;
  error: string;
  code?: string;
}

export interface DetailedWorkspaceArtifactPublishResult {
  artifacts: PublishedWorkspaceArtifact[];
  failures: WorkspaceArtifactPublishFailure[];
}

export class WorkspaceArtifactPublishError extends Error {
  constructor(readonly failures: WorkspaceArtifactPublishFailure[]) {
    super(`Failed to publish ${failures.length} workspace artifact${failures.length === 1 ? "" : "s"}`);
    this.name = "WorkspaceArtifactPublishError";
  }
}

/**
 * Publishes files discovered as execution outputs and returns the exact
 * artifact versions that can be attached to the execution record. Existing
 * content hashes are reused, so retrying an execution does not create a fake
 * new artifact version.
 */
export async function publishWorkspaceArtifacts(
  cwd: string,
  paths: string[],
  options: PublishWorkspaceArtifactOptions,
): Promise<PublishedWorkspaceArtifact[]> {
  const result = await publishWorkspaceArtifactsDetailed(cwd, paths, options);
  if (result.failures.length > 0) throw new WorkspaceArtifactPublishError(result.failures);
  return result.artifacts;
}

/**
 * Publishes a batch while retaining non-fatal failures for callers that can
 * record a warning alongside an otherwise successful execution. A file that
 * disappeared between the workspace snapshot and publication is the only
 * expected skip; all other failures are returned to the caller.
 */
export async function publishWorkspaceArtifactsDetailed(
  cwd: string,
  paths: string[],
  options: PublishWorkspaceArtifactOptions,
): Promise<DetailedWorkspaceArtifactPublishResult> {
  const published: PublishedWorkspaceArtifact[] = [];
  const failures: WorkspaceArtifactPublishFailure[] = [];
  for (const path of [...new Set(paths)]) {
    let artifact: PublishedWorkspaceArtifact | null;
    try {
      artifact = await publishWorkspaceArtifact(cwd, path, options);
    } catch (error) {
      const failure: WorkspaceArtifactPublishFailure = {
        path,
        error: error instanceof Error ? error.message : String(error),
        ...((error as NodeJS.ErrnoException)?.code ? { code: (error as NodeJS.ErrnoException).code } : {}),
      };
      failures.push(failure);
      options.onFailure?.(failure);
      continue;
    }
    if (artifact) published.push(artifact);
  }
  return { artifacts: published, failures };
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function publishWorkspaceArtifact(
  cwd: string,
  requestedPath: string,
  options: PublishWorkspaceArtifactOptions,
): Promise<PublishedWorkspaceArtifact | null> {
  const workspace = await validateWorkspaceCwd(cwd);
  const target = await resolveWorkspaceFile(workspace, requestedPath);

  let metadata;
  try {
    metadata = await stat(target);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  if (!metadata.isFile()) return null;

  try { return await publishValidatedArtifact(workspace, target, options); }
  catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

/** Research output lives under private workspace metadata, which the public
 * workspace-file API intentionally forbids. Only this narrow internal entry
 * point may publish it, after checking both lexical and real containment. */
export async function publishResearchOutputArtifact(
  cwd: string,
  outputRoot: string,
  expectedPath: string,
  options: PublishWorkspaceArtifactOptions,
): Promise<PublishedWorkspaceArtifact> {
  const workspace = await validateWorkspaceCwd(cwd);
  const runsRoot = join(metadataRoot(workspace), "runs");
  const outputPath = resolve(outputRoot);
  // macOS /var is a symlink to /private/var. Compare the supplied spelling
  // first, then independently enforce containment after canonicalization.
  const suppliedRunsRoot = join(metadataRoot(cwd), "runs");
  if (!isContained(suppliedRunsRoot, outputPath) || outputPath === resolve(suppliedRunsRoot)) throw new Error("Research output directory escapes the run root");
  const canonicalRuns = await realpath(runsRoot);
  const canonicalOutput = await realpath(outputPath);
  if (!isContained(canonicalRuns, canonicalOutput)) throw new Error("Research output directory escapes the run root");
  if (!expectedPath || isAbsolute(expectedPath)) throw new Error("Invalid research artifact path");
  const target = resolve(outputPath, expectedPath);
  if (!isContained(outputPath, target) || target === outputPath) throw new Error("Research artifact escapes the output directory");
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Research artifact must be a regular file");
  const canonicalTarget = await realpath(target);
  if (!isContained(canonicalOutput, canonicalTarget)) throw new Error("Research artifact escapes the output directory");
  const logicalPath = `research/${relative(metadataRoot(workspace), canonicalTarget).replaceAll("\\", "/")}`;
  return publishValidatedArtifact(workspace, canonicalTarget, options, logicalPath, canonicalOutput);
}

function isContained(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function publishValidatedArtifact(
  workspace: string,
  target: string,
  options: PublishWorkspaceArtifactOptions,
  logicalPath?: string,
  sourceRoot = workspace,
): Promise<PublishedWorkspaceArtifact> {
  const digest = await captureArtifactBlob(workspace, target, sourceRoot);

  const path = logicalPath ?? relative(workspace, target).replaceAll("\\", "/");
  return withFileWriteLock(workspaceFile(workspace, "artifacts.jsonl"), async () => {
    const artifacts = await readJsonLines<ArtifactManifest>(workspaceFile(workspace, "artifacts.jsonl"));
    const artifactId = await artifactIdentity(workspace, path, artifacts);
    const previous = artifacts.filter((item) => item.artifact_id === artifactId).at(-1);
    if (previous?.sha256 === digest.sha256 && previous.blob_sha256 === digest.sha256) {
      // A prior attempt may have saved the manifest and then failed while
      // recording provenance. Repair that partial publication on retry.
      await recordArtifactProvenance(workspace, previous, options);
      return {
        artifact_id: previous.artifact_id,
        version: previous.version,
        path: previous.path,
        sha256: previous.sha256,
        size: previous.size,
      };
    }

    const version = (previous?.version ?? 0) + 1;
    const contentType = previewMime(path);
    const publishedAt = new Date().toISOString();
    const producer = {
      tool: options.tool,
      ...(options.sessionId ? { session_id: options.sessionId } : {}),
      ...(options.executionId ? { execution_id: options.executionId } : {}),
      ...(options.source ? { source: options.source } : {}),
      ...(options.notebookPath ? { notebook_path: options.notebookPath } : {}),
      ...(options.cellId ? { cell_id: options.cellId } : {}),
      ...(options.loopId ? { loop_id: options.loopId } : {}),
      ...(options.candidateId ? { candidate_id: options.candidateId } : {}),
      ...(options.runId ? { run_id: options.runId } : {}),
    };
    const artifact: ArtifactManifest = {
      artifact_id: artifactId,
      version,
      path,
      kind: options.kind ?? previewKind(path),
      mime: contentType,
      size: digest.size,
      sha256: digest.sha256,
      blob_sha256: digest.sha256,
      published_at: publishedAt,
      producer,
      inputs: [],
      environment: {},
      verification: {
        status: "passed",
        checks: { exists: true, readable: true, size: digest.size, sha256: digest.sha256 },
        checked_at: publishedAt,
      },
    };
    await appendJsonLineUnlocked(workspaceFile(workspace, "artifacts.jsonl"), artifact);
    await recordArtifactProvenance(workspace, artifact, options);
    return {
      artifact_id: artifact.artifact_id,
      version: artifact.version,
      path: artifact.path,
      sha256: artifact.sha256,
      size: artifact.size,
    };
  });
}

async function recordArtifactProvenance(
  cwd: string,
  artifact: ArtifactManifest,
  options: PublishWorkspaceArtifactOptions,
): Promise<void> {
  const provenancePath = workspaceFile(cwd, "provenance.jsonl");
  await withFileWriteLock(provenancePath, async () => {
    const records = await readJsonLines<Record<string, unknown>>(provenancePath);
    if (records.some((record) => record.artifactId === artifact.artifact_id && record.artifactVersion === artifact.version)) return;
    const version = records
      .filter((record) => record.path === artifact.path)
      .reduce((max, record) => Math.max(max, Number(record.version ?? 0)), 0) + 1;
    const content = `artifact:${artifact.artifact_id}:${artifact.version}:${artifact.sha256}`;
    await appendJsonLineUnlocked(provenancePath, {
      path: artifact.path,
      version,
      ts: Date.now() / 1000,
      tool: options.tool,
      sessionId: options.sessionId ?? "",
      ...(options.executionId ? { executionId: options.executionId } : {}),
      ...(options.source ? { source: options.source } : {}),
      ...(options.notebookPath ? { notebookPath: options.notebookPath } : {}),
      ...(options.cellId ? { cellId: options.cellId } : {}),
      content,
      contentHash: createHash("sha256").update(content).digest("hex").slice(0, 16),
      artifactId: artifact.artifact_id,
      artifactVersion: artifact.version,
      artifactHash: artifact.sha256,
    });
  });
}
