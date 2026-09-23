import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { installPromptIdentity } from "./prompt-identity.js";

const cleanup: string[] = [];
type Handler = (event: any, context: any) => unknown;

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Pi prompt identity persistence hook", () => {
  it("writes the request identity onto the actual user message before Pi persists it", async () => {
    const cwd = join(tmpdir(), `pi-prompt-identity-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    const sessionId = "session-id";
    const key = createHash("sha256").update(sessionId).digest("hex");
    const markerPath = join(cwd, ".pi-science", "prompt-associations", `${key}.json`);
    await mkdir(join(cwd, ".pi-science", "prompt-associations"), { recursive: true });
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
    cleanup.push(cwd);
    const firstSession = "session-a";
    const key = createHash("sha256").update(firstSession).digest("hex");
    const directory = join(cwd, ".pi-science", "prompt-associations");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${key}.json`), JSON.stringify({ version: 1, session_id: firstSession, client_message_id: "8fd824aa-51d3-4f63-839c-09e021b7970b" }));

    const handlers = new Map<string, (event: any, context: any) => unknown>();
    installPromptIdentity({ on: (event: string, handler: Handler) => { handlers.set(event, handler); } });
    const context = { cwd, sessionManager: { getSessionId: () => "session-b" } };
    handlers.get("before_agent_start")?.({}, context);
    expect(handlers.get("message_end")?.({ message: { role: "user", content: [] } }, context)).toBeUndefined();
  });
});
