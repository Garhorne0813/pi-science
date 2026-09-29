import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PromptRequestRepository, promptAssociationPath } from "./prompt-request-repository.js";
import { metadataRoot, workspaceFile } from "../../storage/persistence.js";
import { SessionRepository, invalidateSessionFileCache } from "./session-repository.js";

const cleanup: string[] = [];
const sessionId = "session-a";
const clientMessageId = "8fd824aa-51d3-4f63-839c-09e021b7970b";
const secondClientMessageId = "91d824aa-51d3-4f63-839c-09e021b7970b";

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-prompt-request-"));
  cleanup.push(cwd);
  await mkdir(join(metadataRoot(cwd), "sessions"), { recursive: true });
  await writeFile(join(metadataRoot(cwd), "sessions", `${sessionId}.jsonl`), JSON.stringify({ type: "session", id: sessionId, cwd }) + "\n", "utf8");
  invalidateSessionFileCache(cwd);
  return cwd;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PromptRequestRepository", () => {
  it("persists intent metadata, deduplicates the same request, and conflicts on changed content", async () => {
    const cwd = await makeWorkspace();
    const repository = new PromptRequestRepository(new SessionRepository(), "server-1");

    await expect(repository.prepare(cwd, sessionId, clientMessageId, "private prompt payload"))
      .resolves.toMatchObject({ dispatch: true, status: { status: "pending" } });
    await expect(repository.prepare(cwd, sessionId, clientMessageId, "private prompt payload"))
      .resolves.toMatchObject({ dispatch: false, status: { status: "pending" } });
    await expect(repository.prepare(cwd, sessionId, clientMessageId, "different"))
      .resolves.toEqual({ conflict: true });

    const ledger = await readFile(workspaceFile(cwd, "prompt-requests.jsonl"), "utf8");
    expect(ledger).not.toContain("private prompt payload");
    expect(await readFile(promptAssociationPath(cwd, sessionId), "utf8"))
      .toContain(clientMessageId);
  });

  it("accepts same-text sends with different IDs as independent requests", async () => {
    const cwd = await makeWorkspace();
    const repository = new PromptRequestRepository(new SessionRepository(), "server-1");
    const first = await repository.prepare(cwd, sessionId, clientMessageId, "status");
    await repository.update(cwd, sessionId, clientMessageId, "accepted");
    await appendFile(join(metadataRoot(cwd), "sessions", `${sessionId}.jsonl`), `${JSON.stringify({
      type: "message",
      id: "durable-user-1",
      message: { role: "user", client_message_id: clientMessageId, content: [{ type: "text", text: "status" }] },
    })}\n`, "utf8");
    invalidateSessionFileCache(cwd);
    const second = await repository.prepare(cwd, sessionId, secondClientMessageId, "status");

    expect(first).toMatchObject({ dispatch: true });
    expect(second).toMatchObject({ dispatch: true });
  });

  it("blocks a different send while an earlier association is unresolved", async () => {
    const cwd = await makeWorkspace();
    const repository = new PromptRequestRepository(new SessionRepository(), "server-1");
    await repository.prepare(cwd, sessionId, clientMessageId, "status");

    await expect(repository.prepare(cwd, sessionId, secondClientMessageId, "status"))
      .resolves.toEqual({ busy: true, blocking_client_message_id: clientMessageId });
  });

  it("recovers the durable Pi entry ID from the message metadata after a restart", async () => {
    const cwd = await makeWorkspace();
    const first = new PromptRequestRepository(new SessionRepository(), "server-before-crash");
    await first.prepare(cwd, sessionId, clientMessageId, "private prompt payload");
    await first.update(cwd, sessionId, clientMessageId, "accepted");
    const sessionPath = join(metadataRoot(cwd), "sessions", `${sessionId}.jsonl`);
    await appendFile(sessionPath, `${JSON.stringify({
      type: "message",
      id: "durable-user-1",
      message: { role: "user", client_message_id: clientMessageId, content: [{ type: "text", text: "status" }] },
    })}\n`, "utf8");
    invalidateSessionFileCache(cwd);

    const restarted = new PromptRequestRepository(new SessionRepository(), "server-after-crash");
    await expect(restarted.getStatus(cwd, sessionId, clientMessageId)).resolves.toEqual({
      status: "persisted",
      client_message_id: clientMessageId,
      durable_message_id: "durable-user-1",
    });
    await expect(new SessionRepository().messagesPage(cwd, sessionId)).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: "durable-user-1", client_message_id: clientMessageId })],
    });
  });

  it("marks unresolved requests indeterminate after a server restart and never dispatches them twice", async () => {
    const cwd = await makeWorkspace();
    const first = new PromptRequestRepository(new SessionRepository(), "server-before-crash");
    await first.prepare(cwd, sessionId, clientMessageId, "private prompt payload");
    await first.update(cwd, sessionId, clientMessageId, "accepted");

    const restarted = new PromptRequestRepository(new SessionRepository(), "server-after-crash");
    await expect(restarted.getStatus(cwd, sessionId, clientMessageId)).resolves.toMatchObject({
      status: "indeterminate",
      client_message_id: clientMessageId,
    });
    await expect(restarted.prepare(cwd, sessionId, clientMessageId, "private prompt payload"))
      .resolves.toMatchObject({ dispatch: false, status: { status: "indeterminate" } });
  });
});
