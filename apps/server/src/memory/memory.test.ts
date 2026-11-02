import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStateStore } from "../storage/sqlite/state-store.js";
import {
  type MemoryContext,
  type MemoryRecord,
  type MemorySettings,
} from "./schema.js";
const user: MemoryContext = {
  ownerId: "alice",
  projectId: "project-a",
  actor: "user",
  sessionId: "session-a",
};
const agent = { ...user, actor: "agent" as const };
let stores: SqliteStateStore[] = [];
let root: string;
let store: SqliteStateStore;
const call = (
  action: string,
  input: Record<string, unknown> = {},
  context = user,
) => store.memory<any>({ action, input, context });
const content = (
  body = "用户偏好中文回答",
  kind = "preference",
  scope = "project",
) => ({
  scope,
  kind,
  title: "Language preference",
  body,
  evidenceLevel: "user_stated",
  sources: [{ kind: "message", locator: "session-a@message-a" }],
});
async function settings(update: (s: MemorySettings) => void) {
  const prev = await call("settings");
  const { revision, ...s } = prev;
  update(s);
  return call("settings.update", { expectedRevision: revision, settings: s });
}
async function write(body?: string, kind?: string, ctx: MemoryContext = agent) {
  return (await call("write", { content: content(body, kind) }, ctx))
    .record as MemoryRecord;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-test-"));
  store = new SqliteStateStore({ path: join(root, "state.sqlite") });
  stores.push(store);
  await store.start();
  await settings((s) => {
    s.enabled = true;
  });
});
afterEach(async () => {
  await Promise.all(stores.map((s) => s.close()));
  stores = [];
  await rm(root, { recursive: true, force: true });
});
describe("unified worker transactions", () => {
  it("restores a consistent snapshot containing records, revisions and review policy", async () => {
    const r = await write();
    await settings((s) => {
      s.review.mode = "all_manual";
    });
    const path = join(root, "backup.sqlite");
    await store.backup(path);
    const restored = new SqliteStateStore({ path });
    stores.push(restored);
    await restored.start();
    expect(
      await restored.memory({
        action: "read",
        context: user,
        input: { id: r.id },
      }),
    ).toMatchObject({ record: { body: r.body, contentHash: r.contentHash } });
    expect(
      await restored.memory({ action: "settings", context: user, input: {} }),
    ).toMatchObject({ review: { mode: "all_manual" } });
  });
  it("defaults features off, enables only validated low-risk smart writes and never self-approves science", async () => {
    const fresh = new SqliteStateStore({ path: ":memory:" });
    stores.push(fresh);
    await fresh.start();
    const s = await fresh.memory<any>({
      action: "settings",
      input: {},
      context: user,
    });
    expect(s).toMatchObject({
      enabled: false,
      review: { mode: "smart" },
      extraction: { enabled: false },
      dream: { enabled: false },
    });
    expect(await write()).toMatchObject({
      status: "active",
      reviewStatus: "not_required",
    });
    const disguised = await write("用户认为模型显著优于基线", "preference");
    expect(disguised.status).toBe("pending_review");
    expect((await call("recall", { q: "模型" })).records).toEqual([]);
    await expect(
      call(
        "approve",
        {
          id: disguised.id,
          expectedRevision: disguised.revision,
          contentHash: disguised.contentHash,
        },
        agent,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it("all_manual queues agent writes while direct user editing low-risk facts remains immediate", async () => {
    await settings((s) => {
      s.review.mode = "all_manual";
      s.dream.updatePolicy = "auto_low_risk";
    });
    expect((await call("settings")).dream.updatePolicy).toBe("suggest_only");
    expect((await write()).status).toBe("pending_review");
    expect((await write(undefined, undefined, user)).status).toBe("active");
  });
  it("binds approval to content hash and revision, preserving old scientific versions until CAS approval", async () => {
    const r = await write(
      "Observed model performance depends on the dataset",
      "finding",
    );
    await expect(
      call("approve", {
        id: r.id,
        expectedRevision: r.revision,
        contentHash: "bad",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const approved = (
      await call("approve", {
        id: r.id,
        expectedRevision: r.revision,
        contentHash: r.contentHash,
      })
    ).record;
    const proposal = (
      await call(
        "write",
        {
          id: r.id,
          operation: "replace",
          expectedRevision: approved.revision,
          contentHash: approved.contentHash,
          content: content("Dataset result has a counterexample", "finding"),
        },
        agent,
      )
    ).proposal;
    expect((await call("read", { id: r.id })).record.body).toBe(r.body);
    await call("approve", {
      proposalId: proposal.id,
      expectedRevision: proposal.expectedRevision,
      contentHash: proposal.contentHash,
    });
    expect((await call("read", { id: r.id })).record).toMatchObject({
      body: proposal.candidate.body,
      status: "active",
      approvedContentHash: proposal.contentHash,
    });
    await expect(
      call("approve", {
        proposalId: proposal.id,
        expectedRevision: proposal.expectedRevision,
        contentHash: proposal.contentHash,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await call("history", { id: r.id })).revisions).toHaveLength(2);
  });
  it("rejecting proposed edits preserves current record; concurrent proposals cannot overwrite the winner", async () => {
    const r = await write();
    await settings((s) => {
      s.review.mode = "all_manual";
    });
    const input = {
      operation: "replace",
      id: r.id,
      expectedRevision: r.revision,
      contentHash: r.contentHash,
      content: content("用户偏好英文回答"),
    };
    const p = (await call("write", input, agent)).proposal;
    await call("reject", {
      proposalId: p.id,
      expectedRevision: p.expectedRevision,
      contentHash: p.contentHash,
    });
    expect((await call("read", { id: r.id })).record.contentHash).toBe(
      r.contentHash,
    );
    const a = (await call("write", input, agent)).proposal;
    const b = (await call("write", input, agent)).proposal;
    await call("approve", {
      proposalId: a.id,
      expectedRevision: a.expectedRevision,
      contentHash: a.contentHash,
    });
    await expect(
      call("approve", {
        proposalId: b.id,
        expectedRevision: b.expectedRevision,
        contentHash: b.contentHash,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("enforces scope, category, Chinese recall, approval filters and hard-delete cleanup", async () => {
    const r = await write();
    const category = await call("category.write", {
      name: "Hidden",
      autoRecall: false,
    });
    await call(
      "write",
      { content: { ...content("用户偏好简体中文"), categoryId: category.id } },
      agent,
    );
    const profile = (
      await call(
        "write",
        { content: content("用户偏好深色界面", "preference", "profile") },
        agent,
      )
    ).record;
    const frame = (
      await call(
        "write",
        {
          content: {
            ...content("用户偏好会话内简洁表达", "preference", "frame"),
            subjectFrameId: "session-a",
          },
        },
        agent,
      )
    ).record;
    expect(
      new Set(
        (await call("recall", { q: "中文" })).records.map(
          (r: MemoryRecord) => r.id,
        ),
      ),
    ).toEqual(new Set([r.id, profile.id]));
    const other = { ...agent, projectId: "project-b" };
    expect(
      (await call("list", {}, other)).records.map((r: MemoryRecord) => r.id),
    ).toEqual([profile.id]);
    await expect(call("read", { id: r.id }, other)).rejects.toMatchObject({
      statusCode: 404,
    });
    await call("frame.delete", { sessionId: "session-a" });
    await expect(call("read", { id: frame.id })).rejects.toMatchObject({
      statusCode: 404,
    });
    await call("delete", {
      id: r.id,
      expectedRevision: r.revision,
      contentHash: r.contentHash,
    });
    expect(
      await store.all("SELECT * FROM memory_revisions WHERE record_id=?", [
        r.id,
      ]),
    ).toEqual([]);
    expect(
      await store.all("SELECT * FROM memory_fts WHERE record_id=?", [r.id]),
    ).toEqual([]);
  });
  it("serializes competing writers across separate SQLite workers and survives restart", async () => {
    const r = await write();
    const second = new SqliteStateStore({ path: join(root, "state.sqlite") });
    stores.push(second);
    await second.start();
    const input = {
      operation: "replace",
      id: r.id,
      expectedRevision: r.revision,
      contentHash: r.contentHash,
      content: content("用户偏好英语"),
    };
    const result = await Promise.allSettled([
      call("write", input, user),
      second.memory({ action: "write", input, context: user }),
    ]);
    expect(result.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    await store.close();
    store = new SqliteStateStore({ path: join(root, "state.sqlite") });
    stores.push(store);
    await store.start();
    expect((await call("read", { id: r.id })).record.revision).toBe(2);
  });
  it("operation idempotency retains results and refuses reuse for another request", async () => {
    const input = { content: content(), operationKey: "once" };
    const a = await call("write", input, agent);
    expect(await call("write", input, agent)).toEqual(a);
    await expect(
      call("write", { ...input, content: content("用户偏好英文") }, agent),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await call("list")).records).toHaveLength(1);
  });
  it("re-evaluates review mode at background commit; cursor and writes are atomic; cancellation blocks late results", async () => {
    await settings((s) => {
      s.extraction.enabled = true;
    });
    const r = await call("run.enqueue", {
      kind: "extraction",
      logicalKey: "extract-1",
      sessionId: "session-a",
      messageIds: ["message-a"],
      watermark: 3,
      deadline: Date.now() + 60000,
    });
    const claim = await call("run.claim", { id: r.id });
    await settings((s) => {
      s.review.mode = "all_manual";
    });
    const result = await call("run.finish", {
      id: r.id,
      leaseToken: claim.leaseToken,
      outputs: [
        {
          content: {
            ...content(),
            sources: [{ kind: "message", locator: "message-a" }],
          },
        },
      ],
      tokens: 30,
      costUsd: 0.01,
    });
    expect(result.results[0].record.status).toBe("pending_review");
    expect(await call("cursor", { sessionId: "session-a" })).toBe(3);
    const next = await call("run.enqueue", {
      kind: "extraction",
      logicalKey: "extract-2",
      sessionId: "session-a",
      messageIds: ["message-a"],
      watermark: 6,
      deadline: Date.now() + 60000,
    });
    const c = await call("run.claim", { id: next.id });
    await call("run.cancel", { id: next.id });
    await expect(
      call("run.finish", {
        id: next.id,
        leaseToken: c.leaseToken,
        outputs: [],
        tokens: 0,
        costUsd: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await call("cursor", { sessionId: "session-a" })).toBe(3);
  });
  it("forged sources roll back both new facts and extraction cursor", async () => {
    await settings((s) => {
      s.extraction.enabled = true;
    });
    const r = await call("run.enqueue", {
      kind: "extraction",
      logicalKey: "forged",
      sessionId: "session-a",
      messageIds: ["real"],
      watermark: 3,
      deadline: Date.now() + 60000,
    });
    const c = await call("run.claim", { id: r.id });
    await expect(
      call("run.finish", {
        id: r.id,
        leaseToken: c.leaseToken,
        outputs: [{ content: content() }],
        tokens: 1,
        costUsd: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await call("cursor", { sessionId: "session-a" })).toBe(0);
    expect((await call("list")).records).toEqual([]);
  });
});

it("clears derived run snapshots on hard deletion and preserves idempotent deletion tombstones", async () => {
  const input = { content: content(), operationKey: "cached-write" };
  const record = (await call("write", input, agent)).record;
  await settings((s) => {
    s.dream.enabled = true;
  });
  const run = await call("run.enqueue", {
    kind: "dream",
    logicalKey: "snapshot",
    records: [record],
    recordIds: [record.id],
    deadline: Date.now() + 60000,
  });
  await call("delete", {
    id: record.id,
    expectedRevision: record.revision,
    contentHash: record.contentHash,
  });
  const snapshot = await call("run.get", { id: run.id });
  expect(snapshot.records).toEqual([]);
  expect(snapshot.status).toBe("cancelled");
  expect(await call("write", input, agent)).toEqual({ deleted: true });
  expect((await call("list")).records).toEqual([]);
});
it("project-level recall can only tighten the global recall policy", async () => {
  await write();
  await call("project.settings.update", { autoRecall: false });
  expect((await call("recall", { q: "中文" })).records).toEqual([]);
  await call("project.settings.update", { autoRecall: true });
  expect((await call("recall", { q: "中文" })).records).toHaveLength(1);
  await settings((s) => {
    s.recall.enabled = false;
  });
  expect((await call("recall", { q: "中文" })).records).toEqual([]);
});

it("deduplicates extraction and sends conflicting preferences to review without changing the active fact", async () => {
  const original = await write();
  const extractor = { ...agent, actor: "extractor" as const };
  const duplicate = await call(
    "write",
    {
      content: {
        ...content(),
        sources: [{ kind: "message", locator: "session-a@message-b" }],
      },
    },
    extractor,
  );
  expect(duplicate).toMatchObject({
    record: { id: original.id },
    duplicate: true,
  });
  const changed = await call(
    "write",
    { content: content("用户偏好英文回答") },
    extractor,
  );
  expect(changed.proposal.status).toBe("pending");
  expect((await call("read", { id: original.id })).record.body).toBe(
    original.body,
  );
});

it("browses all authorized matches beyond legacy caps before sorting and paging", async () => {
  const category = await call("category.write", {
    name: "Replies",
    autoRecall: true,
  });
  const inserted: MemoryRecord[] = [];
  for (let n = 0; n < 230; n++) {
    const c = {
      ...content(
        "User prefers concise reply formatting",
        n % 3 === 0 ? "workflow" : "preference",
      ),
      title: "Reply style",
      ...(n % 2 === 0 ? { categoryId: category.id } : {}),
    };
    let r = (await call("write", { content: c })).record as MemoryRecord;
    if (n % 10 === 0)
      r = (
        await call("write", {
          id: r.id,
          operation: "remove",
          expectedRevision: r.revision,
          contentHash: r.contentHash,
        })
      ).record;
    await store.run(
      "UPDATE memory_records SET data=json_set(data,'$.createdAt',?,'$.updatedAt',?) WHERE id=?",
      [1000 + n, 2000 - n, r.id],
    );
    inserted.push({ ...r, createdAt: 1000 + n, updatedAt: 2000 - n });
  }
  await call(
    "write",
    { content: { ...content(), title: "Reply style" } },
    { ...user, projectId: "other-project" },
  );
  const first = await call("browse", {});
  expect(first).toMatchObject({
    total: 230,
    page: 1,
    pageSize: 20,
    totalPages: 12,
    sort: "updated_desc",
  });
  expect(first.records.map((r: MemoryRecord) => r.id)).toEqual(
    inserted.slice(0, 20).map((r) => r.id),
  );
  const pages = await Promise.all(
    Array.from({ length: 12 }, (_, n) =>
      call("browse", { q: "reply", page: n + 1, sort: "created_desc" }),
    ),
  );
  expect(pages.every((p) => p.total === 230)).toBe(true);
  const ids = pages.flatMap((p) => p.records.map((r: MemoryRecord) => r.id));
  expect(ids).toEqual([...inserted].reverse().map((r) => r.id));
  expect(new Set(ids).size).toBe(230);
  expect(await call("browse", { page: 999 })).toMatchObject({
    page: 12,
    totalPages: 12,
  });
  const filters = {
    q: "reply",
    scope: "project",
    kind: "preference",
    status: "active",
    categoryId: category.id,
    sort: "created_desc",
    pageSize: 100,
  };
  const expected = inserted
    .filter(
      (r) =>
        r.kind === "preference" &&
        r.status === "active" &&
        r.categoryId === category.id,
    )
    .reverse();
  const filtered = await call("browse", filters);
  expect(filtered.total).toBe(expected.length);
  expect(filtered.records.map((r: MemoryRecord) => r.id)).toEqual(
    expected.map((r) => r.id),
  );
  expect(await call("browse", { q: "NoSuchMemory" })).toMatchObject({
    records: [],
    total: 0,
    page: 1,
    totalPages: 1,
  });
  const defaultSearch = await call("browse", { q: "reply" });
  expect(defaultSearch.sort).toBe("relevance");
  for (const invalid of [
    { page: 0 },
    { page: -1 },
    { page: 1.5 },
    { pageSize: 101 },
    { sort: "injected" },
    { status: "unknown" },
  ])
    await expect(call("browse", invalid)).rejects.toBeDefined();
  // This integration case performs hundreds of durable SQLite transactions;
  // native Windows runners need more than Vitest's five-second unit-test default.
}, 30_000);
