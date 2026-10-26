import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStateStore } from "../storage/sqlite/state-store.js";
import { WorkspaceRepository } from "../storage/sqlite/repositories/workspace-repository.js";
import { MemoryService } from "./service.js";
import { MemoryBackground, type BackgroundModel } from "./background.js";
import type { MemoryContext, MemorySettings } from "./schema.js";
let root: string,
  store: SqliteStateStore,
  memory: MemoryService,
  ctx: MemoryContext,
  background: MemoryBackground;
let busy = false;
let model: ReturnType<typeof vi.fn<BackgroundModel>>;
async function configure(fn: (s: MemorySettings) => void) {
  const { revision, ...s } = await memory.command<MemorySettings>(
    ctx,
    "settings",
  );
  fn(s as MemorySettings);
  await memory.command(ctx, "settings.update", {
    expectedRevision: revision,
    settings: s,
  });
}
async function seed() {
  for (let i = 0; i < 3; i++)
    await memory.command(ctx, "write", {
      content: {
        scope: "project",
        kind: "preference",
        title: "Preference " + i,
        body: "用户偏好格式 " + i,
        evidenceLevel: "user_stated",
        sources: [],
      },
    });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-background-"));
  await mkdir(join(root, ".pi-science"));
  store = new SqliteStateStore({ path: join(root, "state.sqlite") });
  memory = new MemoryService(store, new WorkspaceRepository(store));
  ctx = (await memory.context(root)).context;
  busy = false;
  model = vi.fn(async () => ({
    outputs: [],
    tokens: 10,
    costUsd: 0,
    model: "fixture/model",
  }));
  background = new MemoryBackground(
    memory,
    { hasActiveOperations: async () => busy },
    { list: async () => [] },
    model,
  );
  await memory.command(ctx, "touch", { cwd: root });
  await configure((s) => {
    s.enabled = true;
    s.dream.enabled = true;
    s.dream.allowedWindow.enabled = false;
    s.dream.requireIdle = false;
    s.dream.minIntervalHours = 0;
  });
});
afterEach(async () => {
  await background.stop();
  await store.close();
  await rm(root, { recursive: true, force: true });
});
it("does no model work when disabled, busy or without increments", async () => {
  await configure((s) => {
    s.dream.enabled = false;
  });
  expect(await background.enqueue(ctx, root, "dream")).toMatchObject({
    status: "skipped",
    reason: "disabled",
  });
  await configure((s) => {
    s.dream.enabled = true;
  });
  expect(await background.enqueue(ctx, root, "dream")).toMatchObject({
    status: "skipped",
    reason: "no_delta",
  });
  await seed();
  busy = true;
  expect(await background.enqueue(ctx, root, "dream")).toMatchObject({
    status: "skipped",
    reason: "busy",
  });
  expect(model).not.toHaveBeenCalled();
  expect(await store.all("SELECT id FROM memory_dream_runs")).toEqual([]);
});
it("Dream works without Extraction, claims one automatic logical run per window and retains usage", async () => {
  await seed();
  const first = await background.enqueue(ctx, root, "dream", {
    automatic: true,
  });
  await vi.waitFor(async () =>
    expect(
      (await memory.command(ctx, "run.get", { id: first.id })).status,
    ).toBe("completed"),
  );
  expect(model).toHaveBeenCalledOnce();
  expect(await memory.command(ctx, "run.get", { id: first.id })).toMatchObject({
    tokens: 10,
    costUsd: 0,
    actualModel: "fixture/model",
  });
  const again = await background.enqueue(ctx, root, "dream", {
    automatic: true,
    confirmedForceScan: true,
  });
  expect(again.id).toBe(first.id);
  expect((await memory.command(ctx, "settings")).extraction.enabled).toBe(
    false,
  );
});
it("disabling a running worker cancels the durable run and blocks late output", async () => {
  await seed();
  let finish!: (value: Awaited<ReturnType<BackgroundModel>>) => void;
  model.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const run = await background.enqueue(ctx, root, "dream");
  await vi.waitFor(() => expect(model).toHaveBeenCalledOnce());
  await configure((s) => {
    s.dream.enabled = false;
  });
  finish({ outputs: [], tokens: 10, costUsd: 0, model: "fixture" });
  await vi.waitFor(async () =>
    expect((await memory.command(ctx, "run.get", { id: run.id })).status).toBe(
      "cancelled",
    ),
  );
  expect((await memory.command(ctx, "reviews")).proposals).toEqual([]);
});
it("collects bounded sources and emits reviewable changes without rewriting manual records", async () => {
  await seed();
  const original = (await memory.command(ctx, "list")).records[0];
  model.mockResolvedValueOnce({
    outputs: [
      {
        id: original.id,
        expectedRevision: original.revision,
        contentHash: original.contentHash,
        content: {
          scope: "project",
          kind: "preference",
          title: original.title,
          body: "用户偏好简短回答",
          evidenceLevel: "user_stated",
          sources: [],
        },
        reason: "Clarify preference",
      },
    ],
    tokens: 12,
    costUsd: 0,
    model: "fixture",
  });
  const run = await background.enqueue(ctx, root, "dream");
  await vi.waitFor(async () =>
    expect((await memory.command(ctx, "run.get", { id: run.id })).status).toBe(
      "completed",
    ),
  );
  expect(
    (await memory.command(ctx, "read", { id: original.id })).record.body,
  ).toBe(original.body);
  expect((await memory.command(ctx, "reviews")).proposals).toHaveLength(1);
});
it("recovers an expired lease under the same logical run and prevents a second worker from claiming it", async () => {
  await seed();
  const run = await memory.command(ctx, "run.enqueue", {
    kind: "dream",
    logicalKey: "recovery",
    deadline: Date.now() + 60000,
  });
  const a = await memory.command(ctx, "run.claim", { id: run.id });
  expect(await memory.command(ctx, "run.claim", { id: run.id })).toBeNull();
  await store.run(
    "UPDATE memory_dream_runs SET lease_until=0,data=json_set(data,'$.leaseUntil',0) WHERE id=?",
    [run.id],
  );
  const b = await memory.command(ctx, "run.claim", { id: run.id });
  expect(b.id).toBe(a.id);
  expect(b.leaseToken).not.toBe(a.leaseToken);
  await expect(
    memory.command(ctx, "run.finish", {
      id: a.id,
      leaseToken: a.leaseToken,
      outputs: [],
      tokens: 1,
      costUsd: 0,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it("validates file sources through workspace aliases without exposing private files", async () => {
  const alias = join(root, "workspace-alias");
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(root, "preference.txt"), "Chinese replies");
  await writeFile(join(root, ".env"), "private fixture");
  const content = {
    scope: "profile",
    kind: "preference",
    title: "Reply language",
    body: "用户偏好中文回答",
    evidenceLevel: "user_stated",
    sources: [{ kind: "file", locator: "preference.txt" }],
  };
  expect(
    (await memory.validateContent(alias, ctx, content)).sources[0]?.digest,
  ).toMatch(/^[a-f0-9]{64}$/);
  await expect(
    memory.validateContent(alias, ctx, {
      ...content,
      sources: [{ kind: "file", locator: ".env" }],
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
});

it("preserves Profile source-project identity and stops recall when source evidence changes", async () => {
  await writeFile(join(root, "preference.txt"), "Chinese replies");
  const content = await memory.validateContent(root, ctx, {
    scope: "profile",
    kind: "preference",
    title: "Reply language",
    body: "用户偏好中文回答",
    evidenceLevel: "user_stated",
    sources: [{ kind: "file", locator: "preference.txt" }],
  });
  const record = (await memory.command(ctx, "write", { content })).record;
  const other = join(root, "other");
  await mkdir(join(other, ".pi-science"), { recursive: true });
  const otherCtx = (await memory.context(other)).context;
  expect(
    (await memory.recall(other, otherCtx, { q: "中文" })).records.map(
      (r) => r.id,
    ),
  ).toContain(record.id);
  await writeFile(join(root, "preference.txt"), "English replies");
  expect((await memory.recall(other, otherCtx, { q: "中文" })).records).toEqual(
    [],
  );
  expect(
    (await memory.command(ctx, "read", { id: record.id })).record.status,
  ).toBe("needs_review");
});

it("bounds extraction input and advances only the portion of the transcript actually collected", async () => {
  const { sessionRepository } =
    await import("../runtime/node/session-repository.js");
  const messages = Array.from({ length: 50 }, (_, index) => ({
    id: "message-" + index,
    role: index % 3 === 0 ? "tool" : "user",
    content: [{ type: "text", text: "用户偏好中文回答。".repeat(500) }],
  }));
  const spy = vi
    .spyOn(sessionRepository, "messages")
    .mockResolvedValue(messages);
  try {
    await configure((s) => {
      s.extraction.enabled = true;
    });
    const run = await background.enqueue(ctx, root, "extraction", {
      sessionId: "bounded-session",
      automatic: true,
    });
    await vi.waitFor(async () =>
      expect(
        (await memory.command(ctx, "run.get", { id: run.id })).status,
      ).toBe("completed"),
    );
    const saved = await memory.command(ctx, "run.get", { id: run.id });
    expect(saved.watermark).toBeLessThan(messages.length);
    expect(JSON.stringify(saved.messages).length).toBeLessThan(4500);
    expect(
      await memory.command(ctx, "cursor", { sessionId: "bounded-session" }),
    ).toBe(saved.watermark);
  } finally {
    spy.mockRestore();
  }
});

it("records known spend for failed model output and carries it into the same-run retry budget", async () => {
  await seed();
  model.mockRejectedValueOnce(
    Object.assign(new Error("Incomplete background response (length)"), {
      usage: { tokens: 420, costUsd: 0.001, model: "fixture/model" },
    }),
  );
  const requested = await background.enqueue(ctx, root, "dream");
  await vi.waitFor(async () =>
    expect(
      (await memory.command(ctx, "run.get", { id: requested.id })).status,
    ).toBe("failed"),
  );
  expect(
    await memory.command(ctx, "run.get", { id: requested.id }),
  ).toMatchObject({ tokens: 420, costUsd: 0.001, reservedTokens: 0 });
  const retried = await background.retry(ctx, root, requested.id);
  expect(retried.id).toBe(requested.id);
  await vi.waitFor(async () =>
    expect(
      (await memory.command(ctx, "run.get", { id: requested.id })).status,
    ).toBe("completed"),
  );
  expect(
    await memory.command(ctx, "run.get", { id: requested.id }),
  ).toMatchObject({
    priorReservedTokens: 420,
    priorReservedCostUsd: 0.001,
    tokens: 10,
  });
});

it("Dream can review collected historical-message evidence but cannot widen its source range", async () => {
  const { sessionRepository } =
    await import("../runtime/node/session-repository.js");
  const path = vi
    .spyOn(sessionRepository, "findPath")
    .mockResolvedValue("/fixture/session.jsonl");
  const messages = vi.spyOn(sessionRepository, "messages").mockResolvedValue([
    {
      id: "known",
      role: "user",
      content: [{ type: "text", text: "用户偏好中文回答" }],
    },
    {
      id: "outside",
      role: "user",
      content: [{ type: "text", text: "User prefers English replies" }],
    },
  ]);
  try {
    await seed();
    const content = await memory.validateContent(root, ctx, {
      scope: "project",
      kind: "preference",
      title: "Historical reply preference",
      body: "用户偏好中文回答",
      evidenceLevel: "user_stated",
      sources: [{ kind: "message", locator: "historical@known" }],
    });
    const original = (await memory.command(ctx, "write", { content })).record;
    const output = {
      id: original.id,
      expectedRevision: original.revision,
      contentHash: original.contentHash,
      content: { ...content, body: "用户偏好中文回复并保留英文术语" },
      reason: "Clarify wording",
    };
    model.mockResolvedValueOnce({
      outputs: [output],
      tokens: 12,
      costUsd: 0,
      model: "fixture",
    });
    const first = await background.enqueue(ctx, root, "dream");
    await vi.waitFor(async () =>
      expect(
        (await memory.command(ctx, "run.get", { id: first.id })).status,
      ).toBe("completed"),
    );
    expect((await memory.command(ctx, "reviews")).proposals).toHaveLength(1);
    model.mockResolvedValueOnce({
      outputs: [
        {
          ...output,
          content: {
            ...output.content,
            sources: [{ kind: "message", locator: "historical@outside" }],
          },
        },
      ],
      tokens: 12,
      costUsd: 0,
      model: "fixture",
    });
    const second = await background.enqueue(ctx, root, "dream", {
      forceScan: true,
      confirmedForceScan: true,
    });
    await vi.waitFor(async () =>
      expect(
        (await memory.command(ctx, "run.get", { id: second.id })).status,
      ).toBe("failed"),
    );
    expect(
      (await memory.command(ctx, "run.get", { id: second.id })).error,
    ).toContain("Dream evidence outside collected range");
    expect((await memory.command(ctx, "reviews")).proposals).toHaveLength(1);
  } finally {
    path.mockRestore();
    messages.mockRestore();
  }
});

it("normalizes null optional LLM fields while keeping required content validation strict", async () => {
  await seed();
  const original = (await memory.command(ctx, "list")).records[0];
  const candidate = {
    id: original.id,
    expectedRevision: original.revision,
    contentHash: original.contentHash,
    content: {
      scope: "project",
      kind: "preference",
      title: original.title,
      body: "用户偏好简洁中文回答",
      evidenceLevel: "user_stated",
      sources: [],
      categoryId: null,
      artifactId: null,
    },
  };
  model.mockResolvedValueOnce({
    outputs: [candidate],
    tokens: 10,
    costUsd: 0,
    model: "fixture",
  });
  const first = await background.enqueue(ctx, root, "dream");
  await vi.waitFor(async () =>
    expect(
      (await memory.command(ctx, "run.get", { id: first.id })).status,
    ).toBe("completed"),
  );
  expect(
    (await memory.command(ctx, "reviews")).proposals[0].candidate.categoryId,
  ).toBeUndefined();
  model.mockResolvedValueOnce({
    outputs: [{ ...candidate, content: { ...candidate.content, title: null } }],
    tokens: 10,
    costUsd: 0,
    model: "fixture",
  });
  const second = await background.enqueue(ctx, root, "dream", {
    forceScan: true,
    confirmedForceScan: true,
  });
  await vi.waitFor(async () =>
    expect(
      (await memory.command(ctx, "run.get", { id: second.id })).status,
    ).toBe("failed"),
  );
  expect((await memory.command(ctx, "reviews")).proposals).toHaveLength(1);
});
