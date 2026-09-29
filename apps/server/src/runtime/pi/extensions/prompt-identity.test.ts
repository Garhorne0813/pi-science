import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { installPromptIdentity } from "./prompt-identity.js";
import { PromptRequestRepository, promptAssociationPath } from "../../node/prompt-request-repository.js";
import { SessionRepository, invalidateSessionFileCache } from "../../node/session-repository.js";
import { metadataRoot } from "../../../storage/persistence.js";

const cleanup: string[] = [];
type Handler = (event: any, context: any) => unknown;

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Pi prompt identity persistence hook", () => {
  it("reconciles a completed prompt so the next send is not blocked", async () => {
    const cwd = join(tmpdir(), `pi-prompt-follow-up-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd, metadataRoot(cwd));
    const sessionId = "session-follow-up";
    const firstId = "8fd824aa-51d3-4f63-839c-09e021b7970b";
    const secondId = "91d824aa-51d3-4f63-839c-09e021b7970b";
    const sessionFile = join(metadataRoot(cwd), "sessions", `${sessionId}.jsonl`);
    await mkdir(dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
    const repository = new PromptRequestRepository(new SessionRepository());
    expect(await repository.prepare(cwd, sessionId, firstId, "hello"))
      .toMatchObject({ dispatch: true });

    const handlers = new Map<string, Handler>();
    installPromptIdentity({ on: (event: string, handler: Handler) => { handlers.set(event, handler); } });
    const context = { cwd, sessionManager: { getSessionId: () => sessionId } };
    handlers.get("before_agent_start")?.({}, context);
    const persisted = handlers.get("message_end")?.({ message: { role: "user", content: [{ type: "text", text: "hello" }] } }, context) as { message: Record<string, unknown> };
    await appendFile(sessionFile, `${JSON.stringify({ type: "message", id: "durable-user-1", message: persisted.message })}\n`);
    invalidateSessionFileCache(cwd);
    await repository.update(cwd, sessionId, firstId, "accepted");

    expect(await repository.prepare(cwd, sessionId, secondId, "follow up"))
      .toMatchObject({ dispatch: true });
  });

  it("writes the request identity onto the actual user message before Pi persists it", async () => {
    const cwd = join(tmpdir(), `pi-prompt-identity-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd, metadataRoot(cwd));
    const sessionId = "session-id";
    const markerPath = promptAssociationPath(cwd, sessionId);
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, JSON.stringify({ version: 1, session_id: sessionId, client_message_id: "8fd824aa-51d3-4f63-839c-09e021b7970b" }));

    const handlers = new Map<string, (event: any, context: any) => unknown>();
    installPromptIdentity({ on: (event: string, handler: Handler) => { handlers.set(event, handler); } });
    const context = { cwd, sessionManager: { getSessionId: () => sessionId } };
    handlers.get("before_agent_start")?.({}, context);

    const original = { role: "user", content: [{ type: "text", text: "status" }], timestamp: 1 };
    const replaced = handlers.get("message_end")?.({ message: original }, context) as { message: Record<string, unknown> };
    expect(replaced.message).toEqual({ ...original, client_message_id: "8fd824aa-51d3-4f63-839c-09e021b7970b" });
    expect(original).not.toHaveProperty("client_message_id");
    expect(handlers.get("message_end")?.({ message: original }, context)).toBeUndefined();
  });

  it("does not associate a marker from another Pi session", async () => {
    const cwd = join(tmpdir(), `pi-prompt-identity-other-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd, metadataRoot(cwd));
    const firstSession = "session-a";
    const markerPath = promptAssociationPath(cwd, firstSession);
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, JSON.stringify({ version: 1, session_id: firstSession, client_message_id: "8fd824aa-51d3-4f63-839c-09e021b7970b" }));

    const handlers = new Map<string, (event: any, context: any) => unknown>();
    installPromptIdentity({ on: (event: string, handler: Handler) => { handlers.set(event, handler); } });
    const context = { cwd, sessionManager: { getSessionId: () => "session-b" } };
    handlers.get("before_agent_start")?.({}, context);
    expect(handlers.get("message_end")?.({ message: { role: "user", content: [] } }, context)).toBeUndefined();
  });
});
