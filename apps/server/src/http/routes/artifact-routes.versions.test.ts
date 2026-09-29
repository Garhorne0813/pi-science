import { chmod, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../app/app.js";
import type { ServerConfig } from "../../config/config.js";
import { artifactBlobPath } from "../../runtime/artifacts/artifact-blob-store.js";
import { publishWorkspaceArtifacts } from "../../runtime/artifacts/workspace-artifact-publisher.js";
import { moveWorkspaceMetadata } from "../../storage/persistence.js";
import { ensureProject } from "../../project/project-registry.js";
import { artifactIdentity } from "../../runtime/artifacts/artifact-identity.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function config(): ServerConfig {
  return { host: "127.0.0.1", port: 0, corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false, nodeFiles: true, nodePiManager: false, logLevel: "silent" };
}

describe("artifact version content", () => {
  it("continues a legacy artifact history across a workspace rename and both publishers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-artifact-rename-"));
    workspaces.push(root);
    const before = join(root, "before");
    const after = join(root, "after");
    await mkdir(before);
    await mkdir(join(before, ".pi-science"));
    await writeFile(join(before, "report.csv"), "first");
    await writeFile(join(before, ".pi-science", "artifacts.jsonl"), `${JSON.stringify({ artifact_id: "legacy-path-id", version: 1, path: "report.csv", sha256: "old", size: 3 })}\n`);
    const project = await ensureProject(before);
    const newPathId = await artifactIdentity(before, "future.csv", []);
    const app = buildApp(config()); apps.push(app);
    await rename(before, after);
    await moveWorkspaceMetadata(before, after);
    expect((await ensureProject(after)).id).toBe(project.id);
    expect(await artifactIdentity(after, "future.csv", [])).toBe(newPathId);
    await writeFile(join(after, "report.csv"), "second");
    const published = await app.inject({ method: "POST", url: `/api/artifacts/publish?cwd=${encodeURIComponent(after)}`, payload: { path: "report.csv" } });
    expect(published.json()).toMatchObject({ artifact_id: "legacy-path-id", version: 2 });
    await writeFile(join(after, "report.csv"), "third");
    const [automatic] = await publishWorkspaceArtifacts(after, ["report.csv"], { tool: "test" });
    expect(automatic).toMatchObject({ artifact_id: "legacy-path-id", version: 3 });
  });

  it("retains both published versions after the workspace file is removed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-artifact-versions-"));
    workspaces.push(cwd);
    await mkdir(join(cwd, ".pi-science"));
    await writeFile(join(cwd, "result.txt"), "first");
    const app = buildApp(config()); apps.push(app);
    const url = `?cwd=${encodeURIComponent(cwd)}`;
    const first = await app.inject({ method: "POST", url: `/api/artifacts/publish${url}`, payload: { path: "result.txt" } });
    expect(first.statusCode).toBe(200);
    const firstManifest = first.json() as { artifact_id: string; version: number; sha256: string; blob_sha256: string };
    expect(firstManifest).toMatchObject({ version: 1, blob_sha256: firstManifest.sha256 });

    await writeFile(join(cwd, "result.txt"), "second");
    const second = await app.inject({ method: "POST", url: `/api/artifacts/publish${url}`, payload: { path: "result.txt" } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ artifact_id: firstManifest.artifact_id, version: 2 });
    const repeated = await app.inject({ method: "POST", url: `/api/artifacts/publish${url}`, payload: { path: "result.txt" } });
    expect(repeated.json()).toMatchObject({ artifact_id: firstManifest.artifact_id, version: 2 });
    await rm(join(cwd, "result.txt"));

    const v1 = await app.inject({ method: "GET", url: `/api/artifacts/${firstManifest.artifact_id}/content${url}&version=1` });
    const v2 = await app.inject({ method: "GET", url: `/api/artifacts/${firstManifest.artifact_id}/content${url}&version=2` });
    expect(v1.statusCode).toBe(200);
    expect(v1.body).toBe("first");
    expect(v2.statusCode).toBe(200);
    expect(v2.body).toBe("second");
    expect((await app.inject({ method: "POST", url: `/api/artifacts/verify${url}`, payload: { artifact_id: firstManifest.artifact_id, version: 1 } })).json().verification.status).toBe("passed");
    expect(await readFile(artifactBlobPath(cwd, firstManifest.sha256), "utf8")).toBe("first");
  });

  it("does not claim old metadata-only artifacts have immutable content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-legacy-artifact-"));
    workspaces.push(cwd);
    await mkdir(join(cwd, ".pi-science"));
    await writeFile(join(cwd, ".pi-science", "artifacts.jsonl"), `${JSON.stringify({ artifact_id: "legacy", version: 1, path: "old.txt", size: 3, sha256: "0".repeat(64) })}\n`);
    const app = buildApp(config()); apps.push(app);
    const url = `?cwd=${encodeURIComponent(cwd)}`;
    expect((await app.inject({ method: "GET", url: `/api/artifacts/legacy${url}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/artifacts/legacy/content${url}` })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/artifacts/verify${url}`, payload: { artifact_id: "legacy" } })).statusCode).toBe(409);
  });

  it("detects a corrupted saved blob instead of serving it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-corrupt-artifact-"));
    workspaces.push(cwd);
    await mkdir(join(cwd, ".pi-science"));
    await writeFile(join(cwd, "result.txt"), "original");
    const app = buildApp(config()); apps.push(app);
    const url = `?cwd=${encodeURIComponent(cwd)}`;
    const published = await app.inject({ method: "POST", url: `/api/artifacts/publish${url}`, payload: { path: "result.txt" } });
    const item = published.json() as { artifact_id: string; sha256: string };
    await chmod(artifactBlobPath(cwd, item.sha256), 0o600);
    await writeFile(artifactBlobPath(cwd, item.sha256), "corrupt!");
    const verified = await app.inject({ method: "POST", url: `/api/artifacts/verify${url}`, payload: { artifact_id: item.artifact_id } });
    expect(verified.json().verification.status).toBe("failed");
    const current = await app.inject({ method: "GET", url: `/api/artifacts/${item.artifact_id}${url}` });
    expect(current.json().verification.status).toBe("failed");
    expect((await app.inject({ method: "GET", url: `/api/artifacts/${item.artifact_id}/content${url}` })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/artifacts/publish${url}`, payload: { path: "result.txt" } })).statusCode).toBe(409);
  });
});
