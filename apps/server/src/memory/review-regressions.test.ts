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
  await call("run.dispatch", { id: r.id, leaseToken: first.leaseToken });
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
  const nextClaim = await call("run.claim", { id: next.id });
  expect(nextClaim).not.toBeNull();
  await call("run.dispatch", { id: next.id, leaseToken: nextClaim.leaseToken });
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

async function budgetRun(key: string) {
  await configure((s) => {
    s.budget = { dailyTokens: 1000, perRunTokens: 1000, dailyCostUsd: 0.1 };
  });
  const r = await call("run.enqueue", {
    kind: "dream",
    logicalKey: key,
    deadline: Date.now() + 60000,
    maxCostUsd: 0.1,
  });
  return call("run.claim", { id: r.id });
}
async function journal(leaseToken: string) {
  return store.get<any>("SELECT * FROM memory_run_usage WHERE lease_token=?", [
    leaseToken,
  ]);
}
it.each(["cancel", "fail", "interrupted"] as const)(
  "releases an unused claim after %s without consuming the daily budget",
  async (terminal) => {
    const r = await budgetRun(terminal);
    if (terminal === "cancel") await call("run.cancel", { id: r.id });
    else if (terminal === "fail")
      await call("run.fail", {
        id: r.id,
        leaseToken: r.leaseToken,
        error: "before provider dispatch",
      });
    else {
      await store.run(
        "UPDATE memory_dream_runs SET status='interrupted',data=json_set(data,'$.status','interrupted') WHERE id=?",
        [r.id],
      );
      await call("run.reconcile");
    }
    expect(await journal(r.leaseToken)).toMatchObject({
      state: "released",
      reserved_tokens: 0,
      reserved_cost_usd: 0,
      tokens: 0,
      cost_usd: 0,
    });
    expect(await budgetRun(terminal + "-next")).not.toBeNull();
  },
);
it.each([false, true])(
  "recovers a crash across restart; dispatched=%s",
  async (dispatched) => {
    const r = await budgetRun("crash");
    if (dispatched)
      await call("run.dispatch", { id: r.id, leaseToken: r.leaseToken });
    await store.close();
    store = new SqliteStateStore({ path: join(root, "state.sqlite") });
    memory = new MemoryService(store, new WorkspaceRepository(store));
    await store.start();
    await store.run(
      "UPDATE memory_dream_runs SET lease_until=0,data=json_set(data,'$.leaseUntil',0) WHERE id=?",
      [r.id],
    );
    await call("run.reconcile");
    expect(await journal(r.leaseToken)).toMatchObject({
      state: dispatched ? "estimated" : "released",
      reserved_tokens: 0,
      reserved_cost_usd: 0,
      tokens: dispatched ? 1000 : 0,
      cost_usd: dispatched ? 0.1 : 0,
    });
    const reclaimed = await call("run.claim", { id: r.id });
    if (dispatched) expect(reclaimed).toBeNull();
    else {
      expect(reclaimed.leaseToken).not.toBe(r.leaseToken);
      await expect(
        call("run.dispatch", { id: r.id, leaseToken: r.leaseToken }),
      ).rejects.toMatchObject({ statusCode: 409 });
    }
  },
);
it("settles late measured usage after cancellation without reviving the run", async () => {
  const r = await budgetRun("late");
  await call("run.dispatch", { id: r.id, leaseToken: r.leaseToken });
  const cancelled = await call("run.cancel", { id: r.id });
  expect(await call("run.cancel", { id: r.id })).toEqual(cancelled);
  await configure((s) => {
    s.budget.dailyTokens = 1500;
    s.budget.dailyCostUsd = 0.15;
  });
  const next = await call("run.enqueue", {
    kind: "dream",
    logicalKey: "after-late-usage",
    deadline: Date.now() + 60000,
    maxCostUsd: 0.1,
  });
  expect(await call("run.claim", { id: next.id })).toBeNull();
  expect(await journal(r.leaseToken)).toMatchObject({
    state: "estimated",
    tokens: 1000,
    reserved_tokens: 0,
  });
  await call("run.usage", {
    id: r.id,
    leaseToken: r.leaseToken,
    tokens: 10,
    costUsd: 0.001,
  });
  expect(await journal(r.leaseToken)).toMatchObject({
    state: "settled",
    tokens: 10,
    cost_usd: 0.001,
    reserved_tokens: 0,
  });
  expect(await call("run.claim", { id: next.id })).not.toBeNull();
  const run = await call("run.get", { id: r.id });
  expect(run).toMatchObject({
    status: "cancelled",
    usage: { estimatedTokens: 0, measuredTokens: 10 },
  });
  await expect(
    call("run.finish", {
      id: r.id,
      leaseToken: r.leaseToken,
      outputs: [],
      tokens: 10,
      costUsd: 0.001,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await call("run.usage", {
    id: r.id,
    leaseToken: r.leaseToken,
    tokens: 10,
    costUsd: 0.001,
  });
  await expect(
    call("run.usage", {
      id: r.id,
      leaseToken: r.leaseToken,
      tokens: -1,
      costUsd: 0,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});
it("settles a superseded attempt without touching the replacement lease", async () => {
  const a = await budgetRun("superseded");
  await configure((s) => {
    s.budget.dailyTokens = 3000;
    s.budget.dailyCostUsd = 0.3;
  });
  await call("run.dispatch", { id: a.id, leaseToken: a.leaseToken });
  await store.run(
    "UPDATE memory_dream_runs SET lease_until=0,data=json_set(data,'$.leaseUntil',0) WHERE id=?",
    [a.id],
  );
  const b = await call("run.claim", { id: a.id });
  await call("run.usage", {
    id: a.id,
    leaseToken: a.leaseToken,
    tokens: 25,
    costUsd: 0.002,
  });
  expect(await journal(a.leaseToken)).toMatchObject({
    state: "settled",
    tokens: 25,
  });
  expect(await journal(b.leaseToken)).toMatchObject({
    state: "reserved",
    reserved_tokens: 1000,
  });
  expect(await call("run.get", { id: a.id })).toMatchObject({
    status: "running",
    leaseToken: b.leaseToken,
    reservedTokens: 1000,
  });
});
it("reconciles old v6 reservations as unknown spend, never as unused claims", async () => {
  const { loadMigrations } = await import("../storage/sqlite/migrations.js");
  const path = join(root, "v6.sqlite");
  const old = new SqliteStateStore({
    path,
    migrations: (await loadMigrations()).filter((m) => m.version <= 6),
  });
  const upgraded = new SqliteStateStore({ path });
  try {
    await old.start();
    const r = {
      id: "legacy-v6",
      kind: "dream",
      status: "cancelled",
      startedAt: Date.now(),
      leaseToken: "v6-lease",
      reservedTokens: 1000,
      reservedCostUsd: 0.1,
    };
    await old.run("INSERT INTO memory_dream_runs VALUES(?,?,?,?,?,?,?,?)", [
      r.id,
      ctx.ownerId,
      ctx.projectId,
      "dream",
      "v6",
      "cancelled",
      0,
      JSON.stringify(r),
    ]);
    await old.run("INSERT INTO memory_run_usage VALUES(?,?,?,?,?,?,?,?)", [
      r.leaseToken,
      ctx.ownerId,
      r.id,
      0,
      0,
      0,
      1000,
      0.1,
    ]);
    await old.close();
    await upgraded.memory({ context: ctx, action: "run.reconcile", input: {} });
    expect(
      await upgraded.get<any>("SELECT * FROM memory_run_usage"),
    ).toMatchObject({
      state: "estimated",
      tokens: 1000,
      cost_usd: 0.1,
      reserved_tokens: 0,
      reserved_cost_usd: 0,
    });
  } finally {
    await old.close();
    await upgraded.close();
  }
});
it("records safe workspace diagnostics, backs off persistently and resumes after interaction", async () => {
  // A separate missing path leaves this test's SQLite database available.
  const gone = join(root, "gone");
  await mkdir(join(gone, ".pi-science"), { recursive: true });
  const goneCtx = (await memory.context(gone)).context;
  await rm(gone, { recursive: true, force: true });
  await background.tick();
  const event = (await call("runs", {}, goneCtx)).runs.find(
    (r: any) => r.reason === "schedule_error",
  );
  expect(event.diagnostic).toMatchObject({
    code: "ENOENT",
    stage: "workspace",
    failureCount: 1,
  });
  expect(JSON.stringify(event)).not.toContain(gone);
  const first = (await call("schedules")).find(
    (r: any) => r.project_id === goneCtx.projectId,
  );
  await background.tick();
  expect(
    (await call("schedules")).find(
      (r: any) => r.project_id === goneCtx.projectId,
    ).failure_count,
  ).toBe(1);
  await store.run(
    "UPDATE memory_dream_schedules SET next_scan_at=0 WHERE project_id=?",
    [goneCtx.projectId],
  );
  await background.tick();
  const second = (await call("schedules")).find(
    (r: any) => r.project_id === goneCtx.projectId,
  );
  expect(second.failure_count).toBe(2);
  expect(second.next_scan_at).toBeGreaterThan(first.next_scan_at);
  await mkdir(join(gone, ".pi-science"), { recursive: true });
  await call("touch", { cwd: gone }, goneCtx);
  await background.tick();
  expect(
    (await call("schedules")).find(
      (r: any) => r.project_id === goneCtx.projectId,
    ),
  ).toMatchObject({ failure_count: 0, next_scan_at: 0, diagnostic: null });
});
it.each([
  ["EACCES", "EACCES"],
  ["SQLITE_BUSY", "SQLITE_BUSY"],
  ["SECRET_NOT_A_CODE", "SCHEDULER_ERROR"],
])(
  "retains a safe scheduler code for %s without raw messages",
  async (code, expected) => {
    const actual = memory.command.bind(memory);
    vi.spyOn(memory, "command").mockImplementation(
      async (context, action, input) => {
        if (action === "frames")
          throw Object.assign(
            new Error("private path /secret and sk-private-credential"),
            { code },
          );
        return actual(context, action, input);
      },
    );
    try {
      await background.tick();
      const event = (await call("runs")).runs.find(
        (r: any) => r.reason === "schedule_error",
      );
      expect(event.diagnostic).toMatchObject({
        code: expected,
        stage: "frame_reconciliation",
      });
      expect(JSON.stringify(event)).not.toMatch(/secret|credential/);
    } finally {
      vi.restoreAllMocks();
    }
  },
);
it("records measured usage from a provider that returns after cancellation", async () => {
  await seed();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  model.mockImplementationOnce(async () => {
    await barrier;
    return { outputs: [], tokens: 12, costUsd: 0.001, model: "fixture/model" };
  });
  const r = await background.enqueue(ctx, root, "dream");
  await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
  const running = await call("run.get", { id: r.id });
  await call("run.cancel", { id: r.id });
  release();
  await vi.waitFor(async () =>
    expect(await journal(running.leaseToken)).toMatchObject({
      state: "settled",
      tokens: 12,
      cost_usd: 0.001,
    }),
  );
  expect(await call("run.get", { id: r.id })).toMatchObject({
    status: "cancelled",
    usage: { estimatedTokens: 0, measuredTokens: 12 },
  });
});
it("releases quota on a known preflight failure before the provider is invoked", async () => {
  const models = await import("../runtime/agent/worker/agent-models.js");
  const spy = vi
    .spyOn(models, "agentModels")
    .mockReturnValue({ getModel: () => undefined } as any);
  await background.stop();
  background = new MemoryBackground(
    memory,
    { hasActiveOperations: async () => false },
    { list: async () => [] },
  );
  try {
    const r = await call("run.enqueue", {
      kind: "dream",
      logicalKey: "preflight",
      resolvedModel: "missing/model",
      records: [],
      deadline: Date.now() + 60000,
      maxCostUsd: 0.1,
    });
    await background.tick();
    await vi.waitFor(async () =>
      expect(await call("run.get", { id: r.id })).toMatchObject({
        status: "failed",
        usage: { estimatedTokens: 0, measuredTokens: 0, reservedTokens: 0 },
      }),
    );
    const saved = await call("run.get", { id: r.id });
    expect(await journal(saved.leaseToken)).toMatchObject({
      state: "settled",
      cost_usd: 0,
      reserved_cost_usd: 0,
    });
  } finally {
    spy.mockRestore();
  }
});
it("does not treat a zero-filled provider abort as measured zero spend", async () => {
  const models = await import("../runtime/agent/worker/agent-models.js");
  const completeSimple = vi.fn(async () => ({
    stopReason: "aborted",
    errorMessage: "transport interrupted",
    usage: { totalTokens: 0, cost: { total: 0 } },
    content: [],
  }));
  const spy = vi.spyOn(models, "agentModels").mockReturnValue({
    getModel: () => ({ cost: { input: 1, output: 1 }, maxTokens: 1000 }),
    completeSimple,
  } as any);
  await background.stop();
  background = new MemoryBackground(
    memory,
    { hasActiveOperations: async () => false },
    { list: async () => [] },
  );
  try {
    const r = await call("run.enqueue", {
      kind: "dream",
      logicalKey: "unknown-provider-abort",
      resolvedModel: "fixture/model",
      records: [],
      deadline: Date.now() + 60000,
      maxCostUsd: 0.1,
    });
    await background.tick();
    await vi.waitFor(async () =>
      expect((await call("run.get", { id: r.id })).status).toBe("failed"),
    );
    const saved = await call("run.get", { id: r.id });
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(saved.usage.estimatedTokens).toBeGreaterThan(0);
    expect(await journal(saved.leaseToken)).toMatchObject({
      state: "estimated",
      reserved_tokens: 0,
      reserved_cost_usd: 0,
      cost_usd: 0.1,
    });
  } finally {
    spy.mockRestore();
  }
});
it("allows admitted manual runs and explicit retries to recover immediately from schedule backoff", async () => {
  await seed();
  model.mockRejectedValueOnce(new Error("unknown provider failure"));
  const error = () =>
    call("schedule.error", {
      diagnostic: { code: "ENOENT", stage: "workspace" },
    });
  await error();
  const run = await background.enqueue(ctx, root, "dream");
  await vi.waitFor(async () =>
    expect((await call("run.get", { id: run.id })).status).toBe("failed"),
  );
  expect(
    (await call("schedules")).find((s: any) => s.project_id === ctx.projectId)
      .next_scan_at,
  ).toBe(0);
  await error();
  await background.retry(ctx, root, run.id);
  await vi.waitFor(async () =>
    expect((await call("run.get", { id: run.id })).status).toBe("completed"),
  );
  expect(model).toHaveBeenCalledTimes(2);
  expect(
    (await call("schedules")).find((s: any) => s.project_id === ctx.projectId),
  ).toMatchObject({ failure_count: 0, next_scan_at: 0 });
});
