import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  publishWorkspaceArtifacts,
  publishWorkspaceArtifactsDetailed,
  publishResearchOutputArtifact,
} from "./workspace-artifact-publisher.js";
import { artifactBlobPath } from "./artifact-blob-store.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workspace artifact publisher", () => {
  it("publishes detected kernel outputs and records their execution lineage", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-artifact-publisher-"));
    workspaces.push(cwd);
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await mkdir(join(cwd, "outputs"), { recursive: true });
    await writeFile(join(cwd, "outputs", "result.csv"), "value\n1\n", "utf8");

    const first = await publishWorkspaceArtifacts(cwd, ["outputs/result.csv"], {
      tool: "node-kernel-gateway",
      executionId: "exec-cell-1",
      sessionId: "session-1",
      source: "file_notebook",
      notebookPath: "analysis.ipynb",
      cellId: "cell-a",
    });

    expect(first).toHaveLength(1);
    const firstArtifact = first[0]!;
    expect(firstArtifact).toMatchObject({ path: "outputs/result.csv", version: 1, size: 8 });
    expect(await readFile(artifactBlobPath(cwd, firstArtifact.sha256), "utf8")).toBe("value\n1\n");

    const manifests = JSON.parse(`[${(await readFile(join(cwd, ".pi-science", "artifacts.jsonl"), "utf8")).trim().split("\n").join(",")}]`) as Array<Record<string, unknown>>;
    expect(manifests[0]).toMatchObject({
      artifact_id: firstArtifact.artifact_id,
      version: 1,
      path: "outputs/result.csv",
      producer: {
        execution_id: "exec-cell-1",
        notebook_path: "analysis.ipynb",
        cell_id: "cell-a",
      },
    });

    const provenance = JSON.parse(`[${(await readFile(join(cwd, ".pi-science", "provenance.jsonl"), "utf8")).trim().split("\n").join(",")}]`) as Array<Record<string, unknown>>;
    expect(provenance[0]).toMatchObject({
      path: "outputs/result.csv",
      executionId: "exec-cell-1",
      artifactId: firstArtifact.artifact_id,
      artifactVersion: 1,
    });

    await writeFile(join(cwd, "outputs", "result.csv"), "value\n2\n", "utf8");
    const second = await publishWorkspaceArtifacts(cwd, ["outputs/result.csv"], {
      tool: "node-kernel-gateway",
      executionId: "exec-cell-2",
    });
    expect(second[0]).toMatchObject({ artifact_id: firstArtifact.artifact_id, version: 2 });
    expect(await readFile(artifactBlobPath(cwd, firstArtifact.sha256), "utf8")).toBe("value\n1\n");
    expect(await readFile(artifactBlobPath(cwd, second[0]!.sha256), "utf8")).toBe("value\n2\n");
  });

  it("ignores a disappeared file but surfaces artifact persistence failures", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-artifact-publisher-failure-"));
    workspaces.push(cwd);
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await mkdir(join(cwd, "outputs"), { recursive: true });

    await expect(publishWorkspaceArtifacts(cwd, ["outputs/missing.csv"], { tool: "node-kernel-gateway" })).resolves.toEqual([]);

    await writeFile(join(cwd, "outputs", "result.csv"), "value\n1\n", "utf8");
    await mkdir(join(cwd, ".pi-science", "artifacts.jsonl"));
    const failures: string[] = [];
    const detailed = await publishWorkspaceArtifactsDetailed(cwd, ["outputs/result.csv"], {
      tool: "node-kernel-gateway",
      onFailure: (failure) => failures.push(failure.path),
    });

    expect(detailed.artifacts).toEqual([]);
    expect(detailed.failures).toMatchObject([{ path: "outputs/result.csv", code: "EISDIR" }]);
    expect(failures).toEqual(["outputs/result.csv"]);
    await expect(publishWorkspaceArtifacts(cwd, ["outputs/result.csv"], { tool: "node-kernel-gateway" })).rejects.toThrow("Failed to publish 1 workspace artifact");
  });

  it("publishes only contained research-run outputs and deduplicates retries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-research-artifact-"));
    workspaces.push(cwd);
    const outputRoot = join(cwd, ".pi-science", "runs", "run-1", "outputs");
    await mkdir(outputRoot, { recursive: true });
    await writeFile(join(outputRoot, "result.json"), '{"score":1}\n');
    const options = { tool: "research-evaluator", loopId: "loop-1", candidateId: "candidate-1", kind: "data" };
    const first = await publishResearchOutputArtifact(cwd, outputRoot, "result.json", options);
    expect(first).toMatchObject({ version: 1, path: ".pi-science/runs/run-1/outputs/result.json" });
    expect(await publishResearchOutputArtifact(cwd, outputRoot, "result.json", options)).toEqual(first);
    await rm(join(outputRoot, "result.json"));
    expect(await readFile(artifactBlobPath(cwd, first.sha256), "utf8")).toBe('{"score":1}\n');

    await writeFile(join(cwd, "outside.json"), "private");
    if (process.platform !== "win32") {
      await symlink(join(cwd, "outside.json"), join(outputRoot, "escape.json"));
      await expect(publishResearchOutputArtifact(cwd, outputRoot, "escape.json", options)).rejects.toThrow(/regular file/);
    }
    await expect(publishResearchOutputArtifact(cwd, outputRoot, "../../../../outside.json", options)).rejects.toThrow(/escapes/);
    await expect(publishResearchOutputArtifact(cwd, cwd, "outside.json", options)).rejects.toThrow(/escapes/);
  });

  it("repairs provenance after publication was interrupted between the manifest and lineage", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-artifact-retry-"));
    workspaces.push(cwd);
    await mkdir(join(cwd, ".pi-science"));
    await writeFile(join(cwd, "result.txt"), "result");
    await mkdir(join(cwd, ".pi-science", "provenance.jsonl"));
    await expect(publishWorkspaceArtifacts(cwd, ["result.txt"], { tool: "test" })).rejects.toThrow(/Failed to publish/);
    const manifests = (await readFile(join(cwd, ".pi-science", "artifacts.jsonl"), "utf8")).trim().split("\n");
    expect(manifests).toHaveLength(1);

    await rm(join(cwd, ".pi-science", "provenance.jsonl"), { recursive: true });
    const [artifact] = await publishWorkspaceArtifacts(cwd, ["result.txt"], { tool: "test" });
    expect(artifact).toMatchObject({ version: 1 });
    await publishWorkspaceArtifacts(cwd, ["result.txt"], { tool: "test" });
    const provenance = (await readFile(join(cwd, ".pi-science", "provenance.jsonl"), "utf8")).trim().split("\n");
    expect(provenance).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("rejects a blob-store symlink instead of writing outside the workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-artifact-store-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-science-artifact-outside-"));
    workspaces.push(cwd, outside);
    await mkdir(join(cwd, ".pi-science"));
    await symlink(outside, join(cwd, ".pi-science", "artifact-blobs"));
    await writeFile(join(cwd, "result.txt"), "result");
    await expect(publishWorkspaceArtifacts(cwd, ["result.txt"], { tool: "test" })).rejects.toThrow(/Failed to publish/);
    expect(await readdir(outside)).toEqual([]);
  });
});
