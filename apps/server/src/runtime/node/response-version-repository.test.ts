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
    expect(initial.selectedVersionId).toBe(initial.versions[0]!.id);
    expect(initial.updatedAt).toBe(branch.version.createdAt);

    await repository.select(cwd, branch.version.id);
    const selected = (await repository.list(cwd))[0]!;
    expect(selected.selectedVersionId).toBe(branch.version.id);
    expect(selected.updatedAt).toBe(initial.updatedAt);
  });

  it("keeps a failed regeneration from becoming the selected response", async () => {
    const cwd = await workspace();
    const repository = new ResponseVersionRepository();
    const branch = await repository.append(cwd, { sourceSessionId: "s1", sourceUserMessageId: "u1", targetSessionId: "failed" });
    await repository.setStatus(cwd, branch.version.id, "failed");
    await expect(repository.select(cwd, branch.version.id)).resolves.toBeNull();
    const group = (await repository.list(cwd))[0]!;
    expect(group.selectedVersionId).toBe(group.versions[0]!.id);
  });

  it("tracks nested version groups under one stable conversation root", async () => {
    const cwd = await workspace();
    const repository = new ResponseVersionRepository();
    const first = await repository.append(cwd, { sourceSessionId: "s1", sourceUserMessageId: "u1", targetSessionId: "s2" });
    await repository.select(cwd, first.version.id);
    const second = await repository.append(cwd, { sourceSessionId: "s2", sourceUserMessageId: "u-new", targetSessionId: "s3" });
    await repository.select(cwd, second.version.id);

    const groups = await repository.list(cwd, "s1");
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.rootSessionId)).toEqual(["s1", "s1"]);
    await expect(repository.conversation(cwd, "s3")).resolves.toEqual({ rootSessionId: "s1", sessionIds: ["s1", "s2", "s3"] });
  });

  it("retains the source identity while capping a group at fifty versions", async () => {
    const cwd = await workspace();
    const repository = new ResponseVersionRepository();
    for (let index = 2; index <= 52; index += 1) {
      await repository.append(cwd, { sourceSessionId: "s1", sourceUserMessageId: "u1", targetSessionId: `s${index}` });
    }
    const group = (await repository.list(cwd, "s1"))[0]!;
    expect(group.versions).toHaveLength(50);
    expect(group.versions[0]).toMatchObject({ sessionId: "s1", userMessageId: "u1" });
    expect(group.rootSessionId).toBe("s1");
    expect((await repository.conversation(cwd, "s1")).sessionIds).toHaveLength(52);
  });

  it("removes every version group in a conversation component", async () => {
    const cwd = await workspace();
    const repository = new ResponseVersionRepository();
    await repository.append(cwd, { sourceSessionId: "s1", sourceUserMessageId: "u1", targetSessionId: "s2" });
    await repository.append(cwd, { sourceSessionId: "s2", sourceUserMessageId: "u2", targetSessionId: "s3" });
    await expect(repository.removeConversation(cwd, "s2")).resolves.toEqual(["s1", "s2", "s3"]);
    await expect(repository.list(cwd)).resolves.toEqual([]);
  });
});
