import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../app/app.js";
import type { ServerConfig } from "../../config/config.js";
import { invalidateSessionFileCache } from "../../runtime/node/session-repository.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  delete process.env.PI_SCIENCE_HOME;
  delete process.env.PI_SCIENCE_WORKSPACES;
});

function config(): ServerConfig {
  return { host: "127.0.0.1", port: 0, pythonOrigin: "http://127.0.0.1:1", corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false, nodeFiles: false, nodePiManager: false, logLevel: "silent" };
}

async function workspace(): Promise<string> {
  const path = join(tmpdir(), `pi-science-artifact-routes-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(path);
  await mkdir(join(path, ".pi-science"), { recursive: true });
  return path;
}

async function writeWorkspaceFile(cwd: string, path: string, content: string): Promise<void> {
  const target = join(cwd, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content, "utf8");
}

interface ArtifactJson { artifact_id: string; version: number; path: string; schema_version?: number; classification?: string; inputs?: Array<{ artifact_id: string; version: number } | string>; supersedes?: { artifact_id: string; version: number } | null }

async function publish(app: Awaited<ReturnType<typeof buildApp>>, cwd: string, path: string, payload: Record<string, unknown> = {}): Promise<ArtifactJson> {
  const response = await app.inject({ method: "POST", url: `/api/artifacts/publish?cwd=${encodeURIComponent(cwd)}`, payload: { path, ...payload } });
  expect(response.statusCode).toBe(200);
  return response.json() as ArtifactJson;
}

describe("artifact lineage routes", () => {
  it("publishes versioned input refs and returns upstream/downstream lineage", async () => {
    const cwd = await workspace();
    await writeWorkspaceFile(cwd, "raw.csv", "raw,data\n");
    await writeWorkspaceFile(cwd, "clean.csv", "clean,data\n");
    const app = buildApp(config());
    apps.push(app);

    const input = await publish(app, cwd, "raw.csv");
    expect(input).toMatchObject({ schema_version: 2, classification: "deliverable", version: 1 });
    const output = await publish(app, cwd, "clean.csv", { inputs: [{ artifact_id: input.artifact_id, version: 1 }] });
    expect(output.inputs).toEqual([{ artifact_id: input.artifact_id, version: 1 }]);
    expect(output.classification).toBe("deliverable");

    const lineage = await app.inject({ method: "GET", url: `/api/artifacts/${output.artifact_id}/lineage?cwd=${encodeURIComponent(cwd)}` });
    expect(lineage.statusCode).toBe(200);
    const body = lineage.json() as { artifact: ArtifactJson; upstream: Array<{ kind: string; artifact: ArtifactJson }>; downstream: Array<{ kind: string; artifact: ArtifactJson }>; unresolved_inputs: string[] };
    expect(body.artifact.path).toBe("clean.csv");
    expect(body.upstream).toEqual([{ kind: "consumes", artifact: expect.objectContaining({ path: "raw.csv", version: 1 }) }]);
    expect(body.downstream).toEqual([]);
    expect(body.unresolved_inputs).toEqual([]);

    // The input's lineage sees the dependent downstream.
    const inputLineage = await app.inject({ method: "GET", url: `/api/artifacts/${input.artifact_id}/lineage?cwd=${encodeURIComponent(cwd)}` });
    expect(inputLineage.json().downstream).toEqual([{ kind: "consumed_by", artifact: expect.objectContaining({ path: "clean.csv", version: 1 }) }]);
  });

  it("forms bidirectional supersession relations", async () => {
    const cwd = await workspace();
    await writeWorkspaceFile(cwd, "report.md", "v1\n");
    const app = buildApp(config());
    apps.push(app);
    const first = await publish(app, cwd, "report.md");
    await writeWorkspaceFile(cwd, "report.md", "v2 revised\n");
    const second = await publish(app, cwd, "report.md", { supersedes: { artifact_id: first.artifact_id, version: 1 } });

    const lineage = await app.inject({ method: "GET", url: `/api/artifacts/${second.artifact_id}/lineage?cwd=${encodeURIComponent(cwd)}&version=2` });
    const body = lineage.json() as { upstream: Array<{ kind: string; artifact: ArtifactJson }> };
    expect(body.upstream).toEqual([{ kind: "supersedes", artifact: expect.objectContaining({ version: 1 }) }]);

    const oldLineage = await app.inject({ method: "GET", url: `/api/artifacts/${first.artifact_id}/lineage?cwd=${encodeURIComponent(cwd)}&version=1` });
    expect(oldLineage.json().downstream).toEqual([{ kind: "superseded_by", artifact: expect.objectContaining({ version: 2 }) }]);
  });

  it("rejects missing, self-version and duplicate refs with 422", async () => {
    const cwd = await workspace();
    await writeWorkspaceFile(cwd, "a.txt", "a\n");
    await writeWorkspaceFile(cwd, "b.txt", "b\n");
    const app = buildApp(config());
    apps.push(app);
    const a = await publish(app, cwd, "a.txt");

    const missing = await app.inject({ method: "POST", url: `/api/artifacts/publish?cwd=${encodeURIComponent(cwd)}`, payload: { path: "b.txt", inputs: [{ artifact_id: "ghost-id", version: 1 }] } });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error).toContain("does not exist");

    // Publishing the next version of a.txt while referencing that very
    // version (the one being created) must be rejected.
    await writeWorkspaceFile(cwd, "a.txt", "a2\n");
    const self = await app.inject({ method: "POST", url: `/api/artifacts/publish?cwd=${encodeURIComponent(cwd)}`, payload: { path: "a.txt", inputs: [{ artifact_id: a.artifact_id, version: 2 }] } });
    expect(self.statusCode).toBe(422);
    expect(self.json().error).toContain("version being created");

    const duplicate = await app.inject({ method: "POST", url: `/api/artifacts/publish?cwd=${encodeURIComponent(cwd)}`, payload: { path: "b.txt", inputs: [{ artifact_id: a.artifact_id, version: 1 }, { artifact_id: a.artifact_id, version: 1 }] } });
    expect(duplicate.statusCode).toBe(422);
    expect(duplicate.json().error).toBe("duplicate input reference");

    const badClassification = await app.inject({ method: "POST", url: `/api/artifacts/publish?cwd=${encodeURIComponent(cwd)}`, payload: { path: "b.txt", classification: "published" } });
    expect(badClassification.statusCode).toBe(422);
  });

  it("keeps legacy v1 manifests readable and never rewrites them", async () => {
    const cwd = await workspace();
    await writeWorkspaceFile(cwd, "legacy.txt", "old\n");
    const app = buildApp(config());
    apps.push(app);
    // Simulate a pre-v2 row.
    const { appendJsonLine, workspaceFile } = await import("../../storage/persistence.js");
    await appendJsonLine(workspaceFile(cwd, "artifacts.jsonl"), {
      artifact_id: "legacy-id", version: 1, path: "legacy.txt", kind: "text", mime: "text/plain",
      size: 4, sha256: "1234567890abcdef1234567890abcdef", published_at: "2025-01-01T00:00:00.000Z",
      inputs: ["old/input.csv"],
    });
    const raw = await import("node:fs/promises").then(({ readFile }) => readFile(join(cwd, ".pi-science", "artifacts.jsonl"), "utf8"));
    expect(raw).not.toContain("schema_version");

    const listed = await app.inject({ method: "GET", url: `/api/artifacts?cwd=${encodeURIComponent(cwd)}&artifact_id=legacy-id` });
    expect(listed.statusCode).toBe(200);
    const artifact = (listed.json().artifacts as ArtifactJson[])[0]!;
    expect(artifact).toMatchObject({ schema_version: 2, classification: "unspecified", version: 1 });
    expect(artifact.inputs).toEqual(["old/input.csv"]);

    const lineage = await app.inject({ method: "GET", url: `/api/artifacts/legacy-id/lineage?cwd=${encodeURIComponent(cwd)}` });
    expect(lineage.statusCode).toBe(200);
    expect(lineage.json().unresolved_inputs).toEqual(["old/input.csv"]);

    // Still untouched on disk after reads.
    const after = await import("node:fs/promises").then(({ readFile }) => readFile(join(cwd, ".pi-science", "artifacts.jsonl"), "utf8"));
    expect(after).toBe(raw);
  });

  it("returns the last record for an exact version after verification updates", async () => {
    const cwd = await workspace();
    await writeWorkspaceFile(cwd, "data.csv", "x\n");
    const app = buildApp(config());
    apps.push(app);
    const published = await publish(app, cwd, "data.csv");

    const verify = await app.inject({ method: "POST", url: `/api/artifacts/verify?cwd=${encodeURIComponent(cwd)}`, payload: { artifact_id: published.artifact_id, version: 1 } });
    expect(verify.statusCode).toBe(200);
    // The verify response is a normalized v2 manifest with the refreshed verification.
    expect(verify.json()).toMatchObject({ schema_version: 2, classification: "deliverable", artifact_id: published.artifact_id, version: 1 });
    expect(verify.json().verification.status).toBe("passed");

    // The verify append duplicates artifact_id+version; exact-version GET must
    // return the LAST record (with the refreshed verification).
    const exact = await app.inject({ method: "GET", url: `/api/artifacts/${published.artifact_id}?cwd=${encodeURIComponent(cwd)}&version=1` });
    expect(exact.statusCode).toBe(200);
    expect(exact.json()).toMatchObject({ artifact_id: published.artifact_id, version: 1 });
    expect(exact.json().verification.status).toBe("passed");

    // The plain list and latest=1 both collapse the duplicate rows: exactly
    // one manifest per artifact+version, carrying the refreshed verification.
    const list = await app.inject({ method: "GET", url: `/api/artifacts?cwd=${encodeURIComponent(cwd)}&artifact_id=${published.artifact_id}` });
    const listed = list.json().artifacts as ArtifactJson[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ version: 1 });
    expect((listed[0] as { verification?: { status?: string } }).verification?.status).toBe("passed");
    const latest = await app.inject({ method: "GET", url: `/api/artifacts?cwd=${encodeURIComponent(cwd)}&artifact_id=${published.artifact_id}&latest=1` });
    expect(latest.json().artifacts).toHaveLength(1);
    expect((latest.json().artifacts as ArtifactJson[])[0]!.version).toBe(1);
  });

  it("validates the list limit and rejects invalid values", async () => {
    const cwd = await workspace();
    await writeWorkspaceFile(cwd, "a.txt", "a\n");
    const app = buildApp(config());
    apps.push(app);
    await publish(app, cwd, "a.txt");

    for (const bad of ["0", "-1", "1001", "abc", "1.5"]) {
      const response = await app.inject({ method: "GET", url: `/api/artifacts?cwd=${encodeURIComponent(cwd)}&limit=${bad}` });
      expect(response.statusCode, `limit=${bad}`).toBe(400);
    }
    const ok = await app.inject({ method: "GET", url: `/api/artifacts?cwd=${encodeURIComponent(cwd)}&limit=1000` });
    expect(ok.statusCode).toBe(200);
  });

  it("caps combined string and versioned inputs at write time", async () => {
    const cwd = await workspace();
    await writeWorkspaceFile(cwd, "in.csv", "in\n");
    await writeWorkspaceFile(cwd, "out.csv", "out\n");
    const app = buildApp(config());
    apps.push(app);
    const input = await publish(app, cwd, "in.csv");
    const strings = Array.from({ length: 100 }, (_, i) => `legacy/${i}.csv`);

    const over = await app.inject({ method: "POST", url: `/api/artifacts/publish?cwd=${encodeURIComponent(cwd)}`, payload: { path: "out.csv", inputs: [...strings, { artifact_id: input.artifact_id, version: 1 }] } });
    expect(over.statusCode).toBe(422);
    expect(over.json().error).toContain("combined");

    const atCap = await app.inject({ method: "POST", url: `/api/artifacts/publish?cwd=${encodeURIComponent(cwd)}`, payload: { path: "out.csv", inputs: [...strings.slice(0, 99), { artifact_id: input.artifact_id, version: 1 }] } });
    expect(atCap.statusCode).toBe(200);
    expect((atCap.json() as ArtifactJson).inputs).toHaveLength(100);
  });

  it("validates relation payloads before the unchanged-hash no-op", async () => {
    const cwd = await workspace();
    await writeWorkspaceFile(cwd, "same.txt", "same\n");
    const app = buildApp(config());
    apps.push(app);
    await publish(app, cwd, "same.txt");

    // Identical content re-publish with a bogus relation must 422, not silently
    // succeed as a no-op.
    const noop = await app.inject({ method: "POST", url: `/api/artifacts/publish?cwd=${encodeURIComponent(cwd)}`, payload: { path: "same.txt", inputs: [{ artifact_id: "ghost", version: 1 }] } });
    expect(noop.statusCode).toBe(422);
    expect(noop.json().error).toContain("does not exist");

    // A valid no-op still returns the existing manifest without a new version.
    const okNoop = await app.inject({ method: "POST", url: `/api/artifacts/publish?cwd=${encodeURIComponent(cwd)}`, payload: { path: "same.txt" } });
    expect(okNoop.statusCode).toBe(200);
    expect(okNoop.json()).toMatchObject({ version: 1 });
  });

  it("rejects cross-workspace artifact references", async () => {
    const cwdA = await workspace();
    const cwdB = await workspace();
    await writeWorkspaceFile(cwdA, "a.txt", "a\n");
    await writeWorkspaceFile(cwdB, "b.txt", "b\n");
    const app = buildApp(config());
    apps.push(app);
    const a = await publish(app, cwdA, "a.txt");

    // A ref from workspace A cannot resolve inside workspace B.
    const cross = await app.inject({ method: "POST", url: `/api/artifacts/publish?cwd=${encodeURIComponent(cwdB)}`, payload: { path: "b.txt", inputs: [{ artifact_id: a.artifact_id, version: 1 }] } });
    expect(cross.statusCode).toBe(422);
    expect(cross.json().error).toContain("does not exist");
  });

  it("filters by path and latest=1", async () => {
    const cwd = await workspace();
    await writeWorkspaceFile(cwd, "plot.png", "png1");
    const app = buildApp(config());
    apps.push(app);
    await publish(app, cwd, "plot.png");
    await writeWorkspaceFile(cwd, "plot.png", "png2");
    await publish(app, cwd, "plot.png");

    const byPath = await app.inject({ method: "GET", url: `/api/artifacts?cwd=${encodeURIComponent(cwd)}&path=plot.png` });
    expect((byPath.json().artifacts as ArtifactJson[]).map((item) => item.version)).toEqual([2, 1]);

    const latest = await app.inject({ method: "GET", url: `/api/artifacts?cwd=${encodeURIComponent(cwd)}&path=plot.png&latest=1` });
    const artifacts = latest.json().artifacts as ArtifactJson[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.version).toBe(2);
  });

  it("auto-discovered intermediate manifests are distinct from explicit publish", async () => {
    const cwd = await workspace();
    const app = buildApp(config());
    apps.push(app);
    await writeWorkspaceFile(cwd, "auto.txt", "auto\n");
    await publish(app, cwd, "auto.txt", { classification: "intermediate" });
    const listed = await app.inject({ method: "GET", url: `/api/artifacts?cwd=${encodeURIComponent(cwd)}&path=auto.txt&latest=1` });
    expect((listed.json().artifacts as ArtifactJson[])[0]).toMatchObject({ classification: "intermediate", schema_version: 2 });
  });
});
