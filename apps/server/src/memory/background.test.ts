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

it("queues science review with its own deduplication and leaves extraction cursor intact", async () => {
  const { sessionRepository } = await import("../runtime/node/session-repository.js");
  const path = vi.spyOn(sessionRepository, "findPath").mockResolvedValue("/fixture/session.jsonl");
  const messages = vi.spyOn(sessionRepository, "messages").mockResolvedValue([
    { id: "report", role: "assistant", runId: "turn", turnStatus: "completed", content: [{ type: "text", text: "Scientific report. ".repeat(100) }] },
  ]);
  try {
    await configure((s) => { s.extraction.enabled = true; });
    vi.stubEnv("PI_SCIENCE_SCIENCE_REVIEW", "0");
    expect(await background.enqueue(ctx, root, "extraction", { sessionId: "session", automatic: true, scienceReview: true, turnId: "turn" })).toMatchObject({ status: "skipped", reason: "science_review_disabled", purpose: "science_review" });
    vi.stubEnv("PI_SCIENCE_SCIENCE_REVIEW", "1");
    model.mockResolvedValueOnce({
      outputs: [{ content: { scope: "project", kind: "finding", title: "Unverified claim", body: "The reported result has no corresponding execution record.", evidenceLevel: "inferred", sources: [{ kind: "message", locator: "report" }] } }],
      tokens: 20, costUsd: 0, model: "fixture/model",
    });
    const [run, concurrent] = await Promise.all([
      background.enqueue(ctx, root, "extraction", { sessionId: "session", automatic: true, scienceReview: true, turnId: "turn" }),
      background.enqueue(ctx, root, "extraction", { sessionId: "session", automatic: true, scienceReview: true, turnId: "turn" }),
    ]);
    expect(concurrent.id).toBe(run.id);
    await vi.waitFor(async () => expect((await memory.command(ctx, "run.get", { id: run.id })).status).toBe("completed"));
    const again = await background.enqueue(ctx, root, "extraction", { sessionId: "session", automatic: true, scienceReview: true, turnId: "turn" });
    expect(again.id).toBe(run.id);
    expect(model).toHaveBeenCalledOnce();
    expect(await memory.command(ctx, "cursor", { sessionId: "session" })).toBe(0);
    const review = await memory.command(ctx, "reviews");
    expect(review.records).toHaveLength(1);
    expect(review.records[0]).toMatchObject({ kind: "finding", reviewStatus: "pending" });
    expect(model.mock.calls[0]?.[0]).toContain("Scientific report");
  } finally {
    path.mockRestore(); messages.mockRestore(); vi.unstubAllEnvs();
  }
});

it("rejects a science review result that fabricates its message source", async () => {
  const { sessionRepository } = await import("../runtime/node/session-repository.js");
  const path = vi.spyOn(sessionRepository, "findPath").mockResolvedValue("/fixture/session.jsonl");
  const messages = vi.spyOn(sessionRepository, "messages").mockResolvedValue([
    { id: "report", role: "assistant", content: [{ type: "text", text: "Scientific report. ".repeat(100) }] },
    { id: "other", role: "user", content: [{ type: "text", text: "Other message" }] },
  ]);
  try {
    await configure((s) => { s.extraction.enabled = true; });
    model.mockResolvedValueOnce({ outputs: [{ content: { scope: "project", kind: "finding", title: "Unsupported", body: "An unsupported result.", evidenceLevel: "inferred", sources: [{ kind: "message", locator: "other" }] } }], tokens: 20, costUsd: 0, model: "fixture/model" });
    const run = await background.enqueue(ctx, root, "extraction", { sessionId: "session", scienceReview: true });
    await vi.waitFor(async () => expect((await memory.command(ctx, "run.get", { id: run.id })).status).toBe("failed"));
    expect((await memory.command(ctx, "reviews")).records).toHaveLength(0);
    expect(await memory.command(ctx, "cursor", { sessionId: "session" })).toBe(0);
  } finally { path.mockRestore(); messages.mockRestore(); }
});

it("queues a busy science review and discards output after cancellation", async () => {
  const { sessionRepository } = await import("../runtime/node/session-repository.js");
  const path = vi.spyOn(sessionRepository, "findPath").mockResolvedValue("/fixture/session.jsonl");
  const messages = vi.spyOn(sessionRepository, "messages").mockResolvedValue([
    { id: "report", role: "assistant", content: [{ type: "text", text: "Scientific report. ".repeat(100) }] },
  ]);
  try {
    await configure((s) => { s.extraction.enabled = true; });
    let finish!: (value: Awaited<ReturnType<BackgroundModel>>) => void;
    model.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    busy = true;
    const run = await background.enqueue(ctx, root, "extraction", { sessionId: "session", scienceReview: true });
    expect(run.status).toBe("queued");
    expect(model).not.toHaveBeenCalled();
    busy = false;
    await background.tick();
    await vi.waitFor(() => expect(model).toHaveBeenCalledOnce());
    await memory.command(ctx, "run.cancel", { id: run.id });
    finish({ outputs: [{ content: { scope: "project", kind: "finding", title: "Late result", body: "Should not be saved", evidenceLevel: "inferred", sources: [{ kind: "message", locator: "report" }] } }], tokens: 10, costUsd: 0, model: "fixture" });
    await vi.waitFor(async () => expect((await memory.command(ctx, "run.get", { id: run.id })).status).toBe("cancelled"));
    await background.stop();
    expect((await memory.command(ctx, "reviews")).records).toHaveLength(0);
  } finally { path.mockRestore(); messages.mockRestore(); }
});

it("requests an automatic science review on a settled turn without a frontend", async () => {
  const { sessionRepository } = await import("../runtime/node/session-repository.js");
  const path = vi.spyOn(sessionRepository, "findPath").mockResolvedValue("/fixture/session.jsonl");
  const messages = vi.spyOn(sessionRepository, "messages").mockResolvedValue([
    { id: "report", role: "assistant", runId: "turn", turnStatus: "completed", content: [{ type: "text", text: "Scientific report. ".repeat(100) }] },
  ]);
  try {
    await configure((s) => { s.extraction.enabled = true; });
    vi.stubEnv("PI_SCIENCE_SCIENCE_REVIEW", "1");
    await background.turnCompleted(root, "session", "turn", "completed");
    await vi.waitFor(() => expect(model).toHaveBeenCalledOnce());
    const runs = (await memory.command(ctx, "runs")).runs;
    expect(runs.some((run: { purpose?: string }) => run.purpose === "science_review")).toBe(true);
    expect(model.mock.calls[0]?.[0]).toContain("scientific integrity");
  } finally { path.mockRestore(); messages.mockRestore(); vi.unstubAllEnvs(); }
});

it("does not review an old report for failed, aborted or answerless turns", async () => {
  const { sessionRepository } = await import("../runtime/node/session-repository.js");
  const path = vi.spyOn(sessionRepository, "findPath").mockResolvedValue("/fixture/session.jsonl");
  const messages = vi.spyOn(sessionRepository, "messages").mockResolvedValue([
    { id: "report", role: "assistant", runId: "old-turn", content: [{ type: "text", text: "Scientific report. ".repeat(100) }] },
    { id: "cancelled", role: "assistant", runId: "cancelled-turn", turnStatus: "aborted", content: [{ type: "text", text: "Scientific report. ".repeat(100) }] },
    { id: "intermediate", role: "assistant", runId: "intermediate-turn", turnStatus: "completed", presentationRole: "intermediate", content: [{ type: "text", text: "Scientific report. ".repeat(100) }] },
  ]);
  try {
    await configure((s) => { s.extraction.enabled = true; });
    vi.stubEnv("PI_SCIENCE_SCIENCE_REVIEW", "1");
    await background.turnCompleted(root, "session", "failed-turn", "failed");
    await background.turnCompleted(root, "session", "aborted-turn", "aborted");
    await background.turnCompleted(root, "session", "empty-turn", "completed");
    expect(await background.enqueue(ctx, root, "extraction", { sessionId: "session", automatic: true, scienceReview: true, turnId: "cancelled-turn" })).toMatchObject({ status: "skipped", reason: "no_report" });
    expect(await background.enqueue(ctx, root, "extraction", { sessionId: "session", automatic: true, scienceReview: true, turnId: "intermediate-turn" })).toMatchObject({ status: "skipped", reason: "no_report" });
    expect(model.mock.calls.every(([prompt]) => !prompt.includes("scientific integrity"))).toBe(true);
    const runs = (await memory.command(ctx, "runs")).runs;
    expect(runs.filter((run: { purpose?: string; status?: string }) => run.purpose === "science_review" && run.status !== "skipped")).toHaveLength(0);
  } finally { path.mockRestore(); messages.mockRestore(); vi.unstubAllEnvs(); }
});

it("queues an automatic review through the HTTP route for the specified turn", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerProjectRoutes } = await import("../http/routes/project-routes.js");
  const { sessionRepository } = await import("../runtime/node/session-repository.js");
  const path = vi.spyOn(sessionRepository, "findPath").mockResolvedValue("/fixture/session.jsonl");
  const messages = vi.spyOn(sessionRepository, "messages").mockResolvedValue([
    { id: "report", role: "assistant", runId: "turn", turnStatus: "completed", content: [{ type: "text", text: "Scientific report. ".repeat(100) }] },
  ]);
  const app = Fastify();
  registerProjectRoutes(app, memory, background);
  try {
    await configure((s) => { s.extraction.enabled = true; });
    vi.stubEnv("PI_SCIENCE_SCIENCE_REVIEW", "1");
    const response = await app.inject({ method: "POST", url: "/api/project-knowledge/science-review", payload: { cwd: root, session_id: "session", trigger: "auto", turn_id: "turn" } });
    expect(response.statusCode).toBe(200);
    const run = response.json();
    expect(run).toMatchObject({ status: "queued", purpose: "science_review" });
    await vi.waitFor(async () => expect((await memory.command(ctx, "run.get", { id: run.id })).status).toBe("completed"));
  } finally { await app.close(); path.mockRestore(); messages.mockRestore(); vi.unstubAllEnvs(); }
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
