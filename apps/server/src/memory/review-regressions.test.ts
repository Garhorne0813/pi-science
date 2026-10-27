import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStateStore } from "../storage/sqlite/state-store.js";
import { WorkspaceRepository } from "../storage/sqlite/repositories/workspace-repository.js";
import { MemoryService } from "./service.js";
import { MemoryBackground, type BackgroundModel } from "./background.js";
import {
  scientific,
  type MemoryContext,
  type MemorySettings,
} from "./schema.js";
let root: string,
  store: SqliteStateStore,
  memory: MemoryService,
  ctx: MemoryContext,
  background: MemoryBackground,
  model: ReturnType<typeof vi.fn<BackgroundModel>>;
const content = (
  body = "User prefers concise replies",
  title = "Reply style",
) => ({
  scope: "project" as const,
  kind: "preference" as const,
  title,
  body,
  evidenceLevel: "user_stated" as const,
  sources: [],
});
const call = (
  action: string,
  input: Record<string, unknown> = {},
  context = ctx,
) => memory.command<any>(context, action, input);
async function configure(fn: (s: MemorySettings) => void) {
  const { revision, ...settings } = await call("settings");
  fn(settings);
  await call("settings.update", { expectedRevision: revision, settings });
}
async function seed() {
  for (let n = 0; n < 3; n++) await call("write", { content: content() });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-review-"));
  await mkdir(join(root, ".pi-science"));
  store = new SqliteStateStore({ path: join(root, "state.sqlite") });
  memory = new MemoryService(store, new WorkspaceRepository(store));
  ctx = (await memory.context(root)).context;
  model = vi.fn(async () => ({
    outputs: [],
    tokens: 10,
    costUsd: 0,
    model: "fixture/model",
  }));
  background = new MemoryBackground(
    memory,
    { hasActiveOperations: async () => false },
    { list: async () => [] },
    model,
  );
  await configure((s) => {
    s.enabled = true;
    s.dream.enabled = true;
    s.dream.requireIdle = false;
    s.dream.allowedWindow.enabled = false;
    s.dream.minIntervalHours = 0;
  });
});
afterEach(async () => {
  await background.stop();
  await store.close();
  await rm(root, { recursive: true, force: true });
});
it.each([
  "Use 37°C as the default format for cell culture.",
  "Use PBS format for cell culture.",
  "User prefers 5 mg/mL in response format.",
  "Use dark theme. Culture cells overnight.",
  "User prefers concise replies; set the incubation temperature.",
  "使用37度作为培养格式",
  "用户偏好中文回答，默认删除异常样本",
])(
  "reviews scientific instructions disguised as preferences: %s",
  async (body) => {
    expect(scientific(content(body))).toBe(true);
    const r = (
      await call(
        "write",
        {
          content: {
            ...content(body),
            sources: [{ kind: "message", locator: "session@user" }],
          },
        },
        { ...ctx, actor: "agent" },
      )
    ).record;
    expect(r.status).toBe("pending_review");
    expect((await call("recall", { q: body })).records).toEqual([]);
  },
);
it.each([
  "User prefers concise replies",
  "Use English replies.",
  "User prefers Markdown replies",
  "用户偏好中文回答",
  "用户偏好深色界面",
])("allows enumerated presentation preferences: %s", (body) =>
  expect(scientific(content(body))).toBe(false),
);
it("reviews unknown titles and scientific kinds even with a safe presentation body", () => {
  expect(scientific(content(undefined, "Incubate cells at 37°C"))).toBe(true);
  expect(scientific({ ...content(), kind: "finding" })).toBe(true);
});
it("isolates missing workspaces and scans the later healthy schedule", async () => {
  await seed();
  const missing = join(root, "missing");
  await mkdir(join(missing, ".pi-science"), { recursive: true });
  await store.run("DELETE FROM memory_dream_schedules");
  const missingCtx = (await memory.context(missing)).context;
  await memory.context(root);
  await rm(missing, { recursive: true, force: true });
  await configure((s) => {
    s.dream.mode = "idle";
    s.dream.oncePerWindow = false;
  });
  await background.tick();
  await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
  expect(
    (await call("runs", {}, missingCtx)).runs.some(
      (r: any) => r.reason === "schedule_error",
    ),
  ).toBe(true);
});
it("preserves cooldown, interval and increment checkpoints beyond 100 UI skips", async () => {
  await seed();
  const first = await background.enqueue(ctx, root, "dream");
  await vi.waitFor(async () =>
    expect((await call("run.get", { id: first.id })).status).toBe("completed"),
  );
  for (let n = 0; n < 125; n++)
    await call("run.skip", { kind: "dream", reason: `fixture-skip-${n}` });
  expect((await call("runs")).runs.some((r: any) => r.id === first.id)).toBe(
    false,
  );
  await configure((s) => {
    s.dream.minIntervalHours = 24;
    s.dream.oncePerWindow = false;
  });
  expect(await background.enqueue(ctx, root, "dream")).toMatchObject({
    reason: "cooldown",
  });
  await configure((s) => {
    s.dream.minIntervalHours = 0;
  });
  expect(await background.enqueue(ctx, root, "dream")).toMatchObject({
    reason: "no_delta",
  });
  await configure((s) => {
    s.dream.mode = "interval";
    s.dream.intervalHours = 24;
  });
  await background.tick();
  expect(model).toHaveBeenCalledTimes(1);
  expect(await call("run.latest", { kind: "dream" })).toMatchObject({
    id: first.id,
  });
}, 15000);
it("accounts for yesterday's failure and today's retry by individual UTC admission day", async () => {
  await configure((s) => {
    s.budget = { dailyTokens: 2000, perRunTokens: 1000, dailyCostUsd: 1 };
  });
  const deadline = Date.now() + 60000;
  const r = await call("run.enqueue", {
    kind: "dream",
    logicalKey: "yesterday",
    deadline,
    maxCostUsd: 0.01,
  });
  const first = await call("run.claim", { id: r.id });
  await call("run.fail", {
    id: r.id,
    leaseToken: first.leaseToken,
    error: "unknown spend",
  });
  const yesterday = Date.now() - 86400000,
    day = yesterday - (yesterday % 86400000);
  await store.run("UPDATE memory_run_usage SET day=? WHERE run_id=?", [
    day,
    r.id,
  ]);
  await store.run(
    "UPDATE memory_dream_runs SET data=json_set(data,'$.startedAt',?) WHERE id=?",
    [yesterday, r.id],
  );
  await call("run.retry", { id: r.id, deadline });
  const second = await call("run.claim", { id: r.id });
  expect(second).not.toBeNull();
  await call("run.finish", {
    id: r.id,
    leaseToken: second.leaseToken,
    outputs: [],
    tokens: 1000,
    costUsd: 0.01,
  });
  const next = await call("run.enqueue", {
    kind: "dream",
    logicalKey: "today-two",
    deadline,
    maxCostUsd: 0.01,
  });
  expect(await call("run.claim", { id: next.id })).not.toBeNull();
  await call("run.cancel", { id: next.id });
  const over = await call("run.enqueue", {
    kind: "dream",
    logicalKey: "today-three",
    deadline,
    maxCostUsd: 0.01,
  });
  expect(await call("run.claim", { id: over.id })).toBeNull();
  const usage = await store.all<{ day: number }>(
    "SELECT day FROM memory_run_usage WHERE run_id=? ORDER BY day",
    [r.id],
  );
  expect(usage).toHaveLength(2);
  expect(usage[0]!.day).toBe(day);
  expect(usage[1]!.day).toBeGreaterThan(day);
});
it("preserves terminal run states and makes cancellation idempotent", async () => {
  for (const status of ["completed", "failed", "interrupted"]) {
    const r = await call("run.enqueue", {
      kind: "dream",
      logicalKey: status,
      deadline: Date.now() + 60000,
    });
    await store.run(
      "UPDATE memory_dream_runs SET status=?,data=json_set(data,'$.status',?,'$.endedAt',123,'$.tokens',42) WHERE id=?",
      [status, status, r.id],
    );
    await expect(call("run.cancel", { id: r.id })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await call("run.get", { id: r.id })).toMatchObject({
      status,
      endedAt: 123,
      tokens: 42,
    });
  }
  const r = await call("run.enqueue", {
    kind: "dream",
    logicalKey: "cancel",
    deadline: Date.now() + 60000,
  });
  const cancelled = await call("run.cancel", { id: r.id });
  expect(await call("run.cancel", { id: r.id })).toEqual(cancelled);
});
it("bounds Agent search previews while keeping full read and human pagination", async () => {
  for (let n = 0; n < 30; n++) await call("write", { content: content() });
  const agent = { ...ctx, actor: "agent" as const };
  const result = await call("agent.search", { q: "reply" }, agent);
  expect(result.records.length).toBeGreaterThan(0);
  expect(result.records.length).toBeLessThanOrEqual(20);
  expect(JSON.stringify(result).length).toBeLessThan(6100);
  expect(result.truncated).toBe(true);
  expect(result.records[0].body).toBeUndefined();
  expect(result.records[0].sources).toBeUndefined();
  expect(
    (await call("read", { id: result.records[0].id }, agent)).record.body,
  ).toBe(content().body);
  expect((await call("browse")).total).toBe(30);
});
it("pins accepted memory sources and invalidates transitive dependents on change", async () => {
  const original = (
    await call("write", {
      content: content("Use English replies", "Reply language"),
    })
  ).record;
  const raw = {
    ...content(),
    sources: [{ kind: "memory", locator: original.id }],
  };
  const pinned = await memory.validateContent(root, ctx, raw);
  expect(pinned.sources[0]).toMatchObject({
    version: String(original.revision),
    digest: original.contentHash,
  });
  const dependent = (await call("write", { content: pinned })).record;
  const chainContent = await memory.validateContent(root, ctx, {
    ...content("User prefers dark theme", "UI theme"),
    sources: [{ kind: "memory", locator: dependent.id }],
  });
  const chain = (await call("write", { content: chainContent })).record;
  await call("write", {
    id: original.id,
    operation: "replace",
    expectedRevision: original.revision,
    contentHash: original.contentHash,
    content: content("Use Chinese replies", "Reply language"),
  });
  for (const id of [dependent.id, chain.id])
    expect((await call("read", { id })).record).toMatchObject({
      status: "needs_review",
      reviewStatus: "stale",
    });
  await expect(
    memory.validateContent(root, ctx, pinned, { requirePinnedMemory: true }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    call("approve", {
      id: dependent.id,
      expectedRevision: dependent.revision,
      contentHash: dependent.contentHash,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});
it("rejects pending, archived and unpinned stored memory evidence", async () => {
  const original = (await call("write", { content: content() })).record;
  const raw = {
    ...content(),
    sources: [{ kind: "memory", locator: original.id }],
  };
  await expect(
    memory.validateContent(root, ctx, raw, { requirePinnedMemory: true }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await call("write", {
    id: original.id,
    operation: "remove",
    expectedRevision: original.revision,
    contentHash: original.contentHash,
  });
  await expect(memory.validateContent(root, ctx, raw)).rejects.toMatchObject({
    statusCode: 409,
  });
  const pending = (
    await call("write", {
      content: content("Use 37°C as the default format for cell culture."),
    })
  ).record;
  await expect(
    memory.validateContent(root, ctx, {
      ...raw,
      sources: [{ kind: "memory", locator: pending.id }],
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it("reconciles unsafe legacy auto-accepted records into review before recall", async () => {
  const r = (
    await call("write", {
      content: content("Use 37°C as the default format for cell culture."),
    })
  ).record;
  await store.run(
    "UPDATE memory_records SET status='active',data=json_set(data,'$.status','active','$.reviewRequired',json('false'),'$.reviewStatus','not_required') WHERE id=?",
    [r.id],
  );
  expect((await call("recall", { q: "culture" })).records).toEqual([]);
  expect((await call("read", { id: r.id })).record).toMatchObject({
    status: "needs_review",
    reviewStatus: "stale",
    reviewRequired: true,
  });
});
it("rejects new memory cycles and invalidates dependents after upstream deletion", async () => {
  const a = (await call("write", { content: content() })).record;
  const pinned = await memory.validateContent(root, ctx, {
    ...content(),
    sources: [{ kind: "memory", locator: a.id }],
  });
  const b = (await call("write", { content: pinned })).record;
  const cycle = await memory.validateContent(root, ctx, {
    ...content(),
    sources: [{ kind: "memory", locator: b.id }],
  });
  await expect(
    call("write", {
      operation: "replace",
      id: a.id,
      expectedRevision: a.revision,
      contentHash: a.contentHash,
      content: cycle,
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  await call("delete", {
    id: a.id,
    expectedRevision: a.revision,
    contentHash: a.contentHash,
  });
  expect((await call("read", { id: b.id })).record.status).toBe("needs_review");
});
it("migrates pre-journal reservations conservatively and retains their budget charge", async () => {
  const { loadMigrations } = await import("../storage/sqlite/migrations.js");
  const path = join(root, "old-state.sqlite");
  const old = new SqliteStateStore({
    path,
    migrations: (await loadMigrations()).filter((m) => m.version <= 5),
  });
  const upgraded = new SqliteStateStore({ path });
  try {
    await old.start();
    const run = {
      id: "old-run",
      kind: "dream",
      status: "failed",
      createdAt: Date.now(),
      startedAt: Date.now(),
      leaseToken: "old-lease",
      tokens: 100,
      costUsd: 0.01,
      priorReservedTokens: 200,
      priorReservedCostUsd: 0.02,
    };
    await old.run("INSERT INTO memory_dream_runs VALUES(?,?,?,?,?,?,?,?)", [
      run.id,
      ctx.ownerId,
      ctx.projectId,
      "dream",
      "legacy",
      "failed",
      0,
      JSON.stringify(run),
    ]);
    await old.close();
    await upgraded.start();
    const usage = await upgraded.get<{ tokens: number; cost: number }>(
      "SELECT SUM(MAX(tokens,reserved_tokens)) tokens,SUM(MAX(cost_usd,reserved_cost_usd)) cost FROM memory_run_usage",
    );
    expect(usage!.tokens).toBe(300);
    expect(usage!.cost).toBeCloseTo(0.03);
    const command = (action: string, input: Record<string, unknown> = {}) =>
      upgraded.memory<any>({ context: ctx, action, input });
    const { revision, ...settings } = await command("settings");
    await command("settings.update", {
      expectedRevision: revision,
      settings: {
        ...settings,
        enabled: true,
        dream: { ...settings.dream, enabled: true },
        budget: { dailyTokens: 1000, perRunTokens: 1000, dailyCostUsd: 1 },
      },
    });
    const r = await command("run.enqueue", {
      kind: "dream",
      logicalKey: "new",
      deadline: Date.now() + 60000,
    });
    expect(await command("run.claim", { id: r.id })).toBeNull();
  } finally {
    await old.close();
    await upgraded.close();
  }
});
