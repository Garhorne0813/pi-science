/** Programmatic artifact publishing (internal API) — used by the remote job
 *  coordinator to register harvested files as artifacts without an HTTP round
 *  trip. Mirrors the publish route's identity/version rules (logical_id
 *  inheritance, version chaining, provenance). */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { appendJsonLineUnlocked, withFileWriteLock, workspaceFile, readJsonLines } from "../../storage/persistence.js";
import { resolveWorkspaceFile } from "../../security/workspace-security.js";
import { chainLatestVersion, collapseManifests, logicalChain } from "./artifact-manifest.js";

export interface PublishArtifactOptions {
  tool?: string;
  session_id?: string;
  model?: string | null;
  run_id?: string | null;
  classification?: "intermediate" | "deliverable" | "unspecified";
}

function mimeOf(path: string): string {
  const table: Record<string, string> = { ".json": "application/json", ".csv": "text/csv", ".txt": "text/plain", ".md": "text/markdown", ".html": "text/html", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".log": "text/plain" };
  return table[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function kindOf(path: string): string {
  const contentType = mimeOf(path);
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("text/") || [".md", ".json", ".yaml", ".yml", ".py", ".sh"].includes(extname(path).toLowerCase())) return "text";
  if ([".csv", ".tsv", ".xlsx", ".parquet"].includes(extname(path).toLowerCase())) return "table";
  return "file";
}

/** Publish a file that already exists in the workspace. Returns the manifest. */
export async function publishArtifactFile(cwd: string, relativePath: string, options: PublishArtifactOptions = {}): Promise<{ artifact_id: string; version: number; path: string }> {
  const target = await resolveWorkspaceFile(cwd, relativePath);
  const bytes = await readFile(target);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifactId = createHash("sha256").update(`${cwd}:${relativePath}`).digest("hex").slice(0, 24);
  return await withFileWriteLock(workspaceFile(cwd, "artifacts.jsonl"), async () => {
    const rows = await readJsonLines<unknown>(workspaceFile(cwd, "artifacts.jsonl"));
    const manifests = collapseManifests(rows);
    const existing = manifests.filter((item) => item.artifact_id === artifactId).sort((left, right) => right.version - left.version)[0];
    const logicalId = existing?.logical_id ?? randomUUID();
    const chain = logicalChain(manifests, logicalId);
    const newVersion = chainLatestVersion(chain.length ? chain : existing ? [existing] : []) + 1;
    if (existing?.sha256 === sha256 && existing.path === relativePath) return { artifact_id: artifactId, version: existing.version, path: existing.path };
    const artifact = {
      schema_version: 2, artifact_id: artifactId, logical_id: logicalId, version: newVersion, path: relativePath,
      kind: kindOf(relativePath), mime: mimeOf(relativePath), size: bytes.length, sha256,
      published_at: new Date().toISOString(),
      producer: { tool: options.tool ?? "publish", session_id: options.session_id ?? "", model: options.model ?? null, run_id: options.run_id ?? null },
      inputs: [], supersedes: null, classification: options.classification ?? "deliverable",
      environment: {}, verification: { status: "passed", checks: { exists: true, readable: true, size: bytes.length, sha256 }, checked_at: new Date().toISOString() },
    };
    await appendJsonLineUnlocked(workspaceFile(cwd, "artifacts.jsonl"), artifact);
    return { artifact_id: artifactId, version: newVersion, path: relativePath };
  });
}
