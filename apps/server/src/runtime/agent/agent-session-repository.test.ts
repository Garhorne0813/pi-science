import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  BACKGROUND_CONTEXT,
  JsonlSessionRepo,
  NodeExecutionEnv,
  operationResult,
} from "@earendil-works/pi-agent-core/node";
import { AgentSessionRepository } from "./agent-session-repository.js";

it("restores aborted and completed turns from durable results, including cursor pages without their user message", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "core-history-"));
  const env = new NodeExecutionEnv({ cwd });
  const ctx = BACKGROUND_CONTEXT;
  const repo = new JsonlSessionRepo({
    fileSystem: env,
    sessionsRoot: join(cwd, ".pi-science", "agent-sessions"),
  });
  try {
    const session = await repo.create({ cwd }, ctx);
    const branch = await session.createBranch("main", null, ctx);
    const first = await branch.appendMessage(
      { role: "user", content: "stop me", timestamp: 1000 },
      ctx,
    );
    const tool = await branch.appendMessage(
      {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "call",
        isError: true,
        content: [{ type: "text", text: "Command aborted" }],
        timestamp: 3000,
      },
      ctx,
    );
    await session.setValue(
      operationResult("stopped-run"),
      {
        operationId: "stopped-run",
        kind: "run",
        status: "aborted",
        fromTipId: null,
        tipId: tool,
        startedAt: 1000,
        endedAt: 3000,
      },
      ctx,
    );
    await branch.appendMessage({ role: "user", content: "next", timestamp: 9000 }, ctx);
    const final = await branch.appendMessage(
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "next-call",
        isError: false,
        content: [{ type: "text", text: "done" }],
        timestamp: 10000,
      },
      ctx,
    );
    await session.setValue(
      operationResult("completed-run"),
      {
        operationId: "completed-run",
        kind: "run",
        status: "completed",
        fromTipId: tool,
        tipId: final,
        startedAt: 9000,
        endedAt: 10000,
      },
      ctx,
    );
    const id = session.metadata.id;
    await session.close(ctx);
    await repo.close(ctx);
    const history = new AgentSessionRepository();
    expect((await history.messages(cwd, id)).find((m) => m.id === first)).toMatchObject({
      turnStatus: "aborted",
      turnStartedAt: "1970-01-01T00:00:01.000Z",
      turnEndedAt: "1970-01-01T00:00:03.000Z",
    });
    const latest = await history.messagesPage(cwd, id, { limit: 1 });
    // The newest page grows back to the user message that opened its turn.
    expect(latest.messages.map((m) => m.role)).toEqual(["user", "toolResult"]);
    expect(latest.messages.at(-1)).toMatchObject({
      id: final,
      turnId: "completed-run",
      turnStatus: "completed",
    });
    // Pages requested with a cursor may still begin mid-turn and keep the
    // durable result attached by ancestry, without their user message.
    const midTurn = await history.messagesPage(cwd, id, { limit: 1, before: latest.next_cursor! });
    expect(midTurn.messages).toHaveLength(1);
    expect(midTurn.messages[0]).toMatchObject({
      id: tool,
      turnId: "stopped-run",
      turnStatus: "aborted",
    });
    const previous = await history.messagesPage(cwd, id, { limit: 2, before: latest.next_cursor! });
    expect(previous.messages.map((m) => m.id)).toEqual([first, tool]);
    expect(previous.messages.find((m) => m.id === tool)).toMatchObject({
      turnId: "stopped-run",
      turnStatus: "aborted",
    });
  } finally {
    await repo.close(ctx);
    await env.cleanup(ctx);
    await rm(cwd, { recursive: true, force: true });
  }
});

/** Append `turns` turns of one user message followed by `steps` assistant messages. */
async function appendTurns(
  branch: Awaited<ReturnType<Awaited<ReturnType<JsonlSessionRepo["create"]>>["createBranch"]>>,
  turns: number,
  steps: number,
  at = 1000,
): Promise<string[]> {
  const ids: string[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    ids.push(
      await branch.appendMessage(
        { role: "user", content: `q${turn}`, timestamp: (at += 1000) },
        BACKGROUND_CONTEXT,
      ),
    );
    for (let step = 0; step < steps; step += 1) {
      ids.push(
        await branch.appendMessage(
          {
            role: "toolResult",
            toolName: "read",
            toolCallId: `call-${turn}-${step}`,
            isError: false,
            content: [{ type: "text", text: `a${turn}.${step}` }],
            timestamp: (at += 1000),
          },
          BACKGROUND_CONTEXT,
        ),
      );
    }
  }
  return ids;
}

it("starts the newest page at the user message that opened its oldest turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "core-history-boundary-"));
  const env = new NodeExecutionEnv({ cwd });
  const ctx = BACKGROUND_CONTEXT;
  const repo = new JsonlSessionRepo({
    fileSystem: env,
    sessionsRoot: join(cwd, ".pi-science", "agent-sessions"),
  });
  try {
    const session = await repo.create({ cwd }, ctx);
    const branch = await session.createBranch("main", null, ctx);
    const ids = await appendTurns(branch, 3, 29);
    const id = session.metadata.id;
    await session.close(ctx);
    await repo.close(ctx);
    const history = new AgentSessionRepository();
    const latest = await history.messagesPage(cwd, id, { limit: 50 });
    // 50 newest end mid-turn, so the page grows back to the third turn's user message.
    expect(latest.messages).toHaveLength(60);
    expect(latest.messages[0]).toMatchObject({ id: ids[30], role: "user" });
    expect(latest.has_more).toBe(true);
    const older = await history.messagesPage(cwd, id, { limit: 50, before: latest.next_cursor! });
    expect(older.messages).toHaveLength(30);
    expect(older.messages[0]).toMatchObject({ id: ids[0], role: "user" });
    expect(older.has_more).toBe(false);
    expect(older.next_cursor).toBeNull();
    // Consecutive pages cover every message exactly once.
    expect([...older.messages, ...latest.messages].map((message) => message.id)).toEqual(ids);
  } finally {
    await repo.close(ctx);
    await env.cleanup(ctx);
    await rm(cwd, { recursive: true, force: true });
  }
});

it("returns one page without a cursor when the history ends on a turn boundary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "core-history-exact-"));
  const env = new NodeExecutionEnv({ cwd });
  const ctx = BACKGROUND_CONTEXT;
  const repo = new JsonlSessionRepo({
    fileSystem: env,
    sessionsRoot: join(cwd, ".pi-science", "agent-sessions"),
  });
  try {
    const session = await repo.create({ cwd }, ctx);
    const branch = await session.createBranch("main", null, ctx);
    const ids = await appendTurns(branch, 25, 1);
    const id = session.metadata.id;
    await session.close(ctx);
    await repo.close(ctx);
    const history = new AgentSessionRepository();
    const latest = await history.messagesPage(cwd, id, { limit: 50 });
    expect(latest.messages.map((message) => message.id)).toEqual(ids);
    expect(latest.has_more).toBe(false);
    expect(latest.next_cursor).toBeNull();
  } finally {
    await repo.close(ctx);
    await env.cleanup(ctx);
    await rm(cwd, { recursive: true, force: true });
  }
});

it("caps the turn-boundary extension at 200 messages for a pathological turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "core-history-cap-"));
  const env = new NodeExecutionEnv({ cwd });
  const ctx = BACKGROUND_CONTEXT;
  const repo = new JsonlSessionRepo({
    fileSystem: env,
    sessionsRoot: join(cwd, ".pi-science", "agent-sessions"),
  });
  try {
    const session = await repo.create({ cwd }, ctx);
    const branch = await session.createBranch("main", null, ctx);
    const ids = await appendTurns(branch, 1, 250);
    const id = session.metadata.id;
    await session.close(ctx);
    await repo.close(ctx);
    const history = new AgentSessionRepository();
    const latest = await history.messagesPage(cwd, id, { limit: 50 });
    expect(latest.messages).toHaveLength(200);
    expect(latest.messages[0]).toMatchObject({ id: ids[51], role: "toolResult" });
    expect(latest.has_more).toBe(true);
    const older = await history.messagesPage(cwd, id, { limit: 100, before: latest.next_cursor! });
    expect(older.messages).toHaveLength(51);
    expect(older.messages[0]).toMatchObject({ id: ids[0], role: "user" });
    expect(older.has_more).toBe(false);
    expect([...older.messages, ...latest.messages].map((message) => message.id)).toEqual(ids);
  } finally {
    await repo.close(ctx);
    await env.cleanup(ctx);
    await rm(cwd, { recursive: true, force: true });
  }
});

it("never repairs a live Worker's partial result transaction while projecting history", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "core-history-live-"));
  const env = new NodeExecutionEnv({ cwd });
  const ctx = BACKGROUND_CONTEXT;
  const repo = new JsonlSessionRepo({
    fileSystem: env,
    sessionsRoot: join(cwd, ".pi-science", "agent-sessions"),
  });
  try {
    const session = await repo.create({ cwd }, ctx);
    const branch = await session.createBranch("main", null, ctx);
    const user = await branch.appendMessage(
      { role: "user", content: "stop before reply", timestamp: 1000 },
      ctx,
    );
    const path = session.metadata.path;
    const beforeResult = await readFile(path, "utf8");
    await session.setValue(
      operationResult("stopped-live"),
      {
        operationId: "stopped-live",
        kind: "run",
        status: "aborted",
        fromTipId: null,
        tipId: user,
        startedAt: 1000,
        endedAt: 2000,
      },
      ctx,
    );
    const complete = await readFile(path, "utf8");
    await session.close(ctx);
    await repo.close(ctx);
    const transaction = complete.slice(beforeResult.length);
    const split = Math.floor(transaction.length / 2);
    const partial = beforeResult + transaction.slice(0, split);
    await writeFile(path, partial);
    const history = new AgentSessionRepository();
    expect((await history.messages(cwd, session.metadata.id))[0]).toMatchObject({ id: user });
    expect(await readFile(path, "utf8")).toBe(partial);
    expect((await history.messagesPage(cwd, session.metadata.id)).messages[0]).not.toHaveProperty(
      "turnStatus",
    );
    expect(await readFile(path, "utf8")).toBe(partial);
    await appendFile(path, transaction.slice(split));
    expect((await history.messages(cwd, session.metadata.id))[0]).toMatchObject({
      id: user,
      turnStatus: "aborted",
    });
    expect(await readFile(path, "utf8")).toBe(complete);
  } finally {
    await repo.close(ctx);
    await env.cleanup(ctx);
    await rm(cwd, { recursive: true, force: true });
  }
});

it("projects a failed model call as readable assistant content instead of an empty array", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "core-history-model-failure-"));
  const env = new NodeExecutionEnv({ cwd });
  const ctx = BACKGROUND_CONTEXT;
  const repo = new JsonlSessionRepo({
    fileSystem: env,
    sessionsRoot: join(cwd, ".pi-science", "agent-sessions"),
  });
  try {
    const session = await repo.create({ cwd }, ctx);
    const branch = await session.createBranch("main", null, ctx);
    const user = await branch.appendMessage(
      { role: "user", content: "Reply with exactly: OK", timestamp: 1000 },
      ctx,
    );
    const failed = await branch.appendMessage(
      {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "Provider is not configured: opencode-go",
        timestamp: 2000,
      },
      ctx,
    );
    const ok = await branch.appendMessage(
      {
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        api: "openai-completions",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 4000,
      },
      ctx,
    );
    await session.setValue(
      operationResult("failed-run"),
      {
        operationId: "failed-run",
        kind: "run",
        status: "failed",
        fromTipId: user,
        tipId: failed,
        startedAt: 1000,
        endedAt: 2000,
      },
      ctx,
    );
    await session.setValue(
      operationResult("ok-run"),
      {
        operationId: "ok-run",
        kind: "run",
        status: "completed",
        fromTipId: failed,
        tipId: ok,
        startedAt: 3000,
        endedAt: 4000,
      },
      ctx,
    );
    const id = session.metadata.id;
    await session.close(ctx);
    await repo.close(ctx);
    const history = new AgentSessionRepository();
    const messages = await history.messages(cwd, id);
    expect(messages.find((message) => message.id === failed)).toMatchObject({
      role: "assistant",
      turnStatus: "failed",
    });
    expect(messages.find((message) => message.id === failed)?.content).toEqual([
      {
        type: "text",
        text: "Model request failed (opencode-go/deepseek-v4.1-flash, credential_missing): Provider is not configured: opencode-go",
      },
    ]);
    expect(messages.find((message) => message.id === ok)?.content).toEqual([
      { type: "text", text: "OK" },
    ]);
  } finally {
    await repo.close(ctx);
    await env.cleanup(ctx);
    await rm(cwd, { recursive: true, force: true });
  }
});
