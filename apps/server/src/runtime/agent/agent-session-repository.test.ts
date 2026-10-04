import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT, JsonlSessionRepo, NodeExecutionEnv, operationResult } from "@earendil-works/pi-agent-core/node";
import { AgentSessionRepository } from "./agent-session-repository.js";

it("restores aborted and completed turns from durable results, including pages without their user message", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "core-history-"));
  const env = new NodeExecutionEnv({ cwd });
  const ctx = BACKGROUND_CONTEXT;
  const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(cwd, ".pi-science", "agent-sessions") });
  try {
    const session = await repo.create({ cwd }, ctx);
    const branch = await session.createBranch("main", null, ctx);
    const first = await branch.appendMessage({ role: "user", content: "stop me", timestamp: 1000 }, ctx);
    const tool = await branch.appendMessage({ role: "toolResult", toolName: "bash", toolCallId: "call", isError: true, content: [{ type: "text", text: "Command aborted" }], timestamp: 3000 }, ctx);
    await session.setValue(operationResult("stopped-run"), { operationId: "stopped-run", kind: "run", status: "aborted", fromTipId: null, tipId: tool, startedAt: 1000, endedAt: 3000 }, ctx);
    await branch.appendMessage({ role: "user", content: "next", timestamp: 9000 }, ctx);
    const final = await branch.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "next-call", isError: false, content: [{ type: "text", text: "done" }], timestamp: 10000 }, ctx);
    await session.setValue(operationResult("completed-run"), { operationId: "completed-run", kind: "run", status: "completed", fromTipId: tool, tipId: final, startedAt: 9000, endedAt: 10000 }, ctx);
    const id = session.metadata.id;
    await session.close(ctx); await repo.close(ctx);
    const history = new AgentSessionRepository();
    expect((await history.messages(cwd, id)).find((m) => m.id === first)).toMatchObject({ turnStatus: "aborted", turnStartedAt: "1970-01-01T00:00:01.000Z", turnEndedAt: "1970-01-01T00:00:03.000Z" });
    const latest = await history.messagesPage(cwd, id, { limit: 1 });
    expect(latest.messages[0]).toMatchObject({ id: final, turnId: "completed-run", turnStatus: "completed" });
    const previous = await history.messagesPage(cwd, id, { limit: 2, before: latest.next_cursor! });
    expect(previous.messages.find((m) => m.id === tool)).toMatchObject({ turnId: "stopped-run", turnStatus: "aborted" });
  } finally { await repo.close(ctx); await env.cleanup(ctx); await rm(cwd, { recursive: true, force: true }); }
});
