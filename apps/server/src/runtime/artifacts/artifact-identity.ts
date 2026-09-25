import { createHash } from "node:crypto";
import { ensureProject } from "../../project/project-registry.js";

/** Preserve existing publication IDs; use stable project identity for new paths. */
export async function artifactIdentity(workspace: string, path: string, manifests: Array<{ path: string; artifact_id: string }>): Promise<string> {
  const existing = manifests.findLast((item) => item.path === path && typeof item.artifact_id === "string");
  if (existing) return existing.artifact_id;
  const project = await ensureProject(workspace);
  return createHash("sha256").update(`${project.id}:${path}`).digest("hex").slice(0, 24);
}
