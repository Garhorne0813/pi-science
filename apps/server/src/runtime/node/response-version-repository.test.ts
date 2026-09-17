import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResponseVersionRepository } from "./response-version-repository.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = join(tmpdir(), `pi-science-response-versions-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(path);
  await mkdir(path, { recursive: true });
  return path;
}

describe("ResponseVersionRepository", () => {
  it("persists one branch group across regenerations from any version", async () => {
    const cwd = await workspace();
    const repository = new ResponseVersionRepository();
    const first = await repository.append(cwd, { sourceSessionId: "s1", sourceUserMessageId: "u1", targetSessionId: "s2", forkEntryId: "e1" });
    await repository.bind(cwd, first.version.id, "u2");
    const second = await repository.append(cwd, { sourceSessionId: "s2", sourceUserMessageId: "u2", targetSessionId: "s3", forkEntryId: "e2" });
    expect(second.group.id).toBe(first.group.id);
    expect((await repository.list(cwd, "s3"))[0]?.versions.map((version) => version.sessionId)).toEqual(["s1", "s2", "s3"]);
  });

  it("binds by version id and records a failed generation", async () => {
    const cwd = await workspace();
    const repository = new ResponseVersionRepository();
    const branch = await repository.append(cwd, { sourceSessionId: "s1", sourceUserMessageId: "u1", targetSessionId: "s2" });
    await repository.bind(cwd, branch.version.id, "u2");
    await repository.setStatus(cwd, branch.version.id, "failed");
    expect((await repository.list(cwd))[0]?.versions[1]).toMatchObject({ id: branch.version.id, userMessageId: "u2", status: "failed" });
  });

  it("persists the last selected response without changing group activity", async () => {
    const cwd = await workspace();
    const repository = new ResponseVersionRepository();
    const branch = await repository.append(cwd, { sourceSessionId: "s1", sourceUserMessageId: "u1", targetSessionId: "s2" });
    const initial = (await repository.list(cwd))[0]!;
    expect(initial.selectedVersionId).toBe(branch.version.id);
    expect(initial.updatedAt).toBe(branch.version.createdAt);

    const firstVersionId = initial.versions[0]!.id;
    await repository.select(cwd, firstVersionId);
    const selected = (await repository.list(cwd))[0]!;
    expect(selected.selectedVersionId).toBe(firstVersionId);
    expect(selected.updatedAt).toBe(initial.updatedAt);
  });
});
