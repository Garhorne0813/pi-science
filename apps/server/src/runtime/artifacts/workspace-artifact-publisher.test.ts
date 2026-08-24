import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishWorkspaceArtifacts } from "./workspace-artifact-publisher.js";

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
  });
});
