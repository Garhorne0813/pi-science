import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerModules } from "../../app/server-modules.js";
import { buildApp } from "../../app/app.js";
import type { ServerConfig } from "../../config/config.js";
import { memoryGrant, verifyMemoryGrant } from "../../memory/service.js";
import { AgentSessionRepository } from "../../runtime/agent/agent-session-repository.js";
let cwd: string;
let app: ReturnType<typeof buildApp>;
let modules: ReturnType<typeof createServerModules>;
const config: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  corsOrigins: [],
  maxBodyBytes: 1000000,
  upstreamTimeoutMs: 100,
  nodeSessions: false,
  nodeSse: false,
  nodeFiles: true,
  nodePiManager: false,
  logLevel: "silent",
  internalToken: "memory-route-test",
  requireInternalToken: false,
};
const request = async (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url:
      "/api/memory" +
      path +
      (path.includes("?") ? "&" : "?") +
      "cwd=" +
      encodeURIComponent(cwd),
    ...(payload === undefined ? {} : { payload: payload as any }),
  });
const content = (body = "用户偏好中文", kind = "preference") => ({
  scope: "project",
  title: "Preference",
  body,
  kind,
  evidenceLevel: "user_stated",
  sources: [],
});
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "memory-routes-"));
  vi.stubEnv("PI_SCIENCE_HOME", join(cwd, "control"));
  await mkdir(join(cwd, ".pi-science"));
  modules = createServerModules(config);
  app = buildApp(config, modules);
  await app.ready();
  const s = (await request("GET", "/settings")).json();
  const { revision, ...rest } = s;
  expect(
    (
      await request("PATCH", "/settings", {
        expectedRevision: revision,
        settings: { ...rest, enabled: true },
      })
    ).statusCode,
  ).toBe(200);
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  await rm(cwd, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
it("reports disabled Memory before validating model-supplied evidence", async () => {
  const { revision, ...settings } = (await request("GET", "/settings")).json();
  expect((await request("PATCH", "/settings", {
    expectedRevision: revision, settings: { ...settings, enabled: false },
  })).statusCode).toBe(200);
  vi.spyOn(modules.sessions, "exists").mockResolvedValue(true);
  vi.spyOn(AgentSessionRepository.prototype, "findPath").mockResolvedValue(join(cwd, "session.jsonl"));
  const response = await app.inject({
    method: "POST", url: "/api/memory/agent/write",
    headers: { "x-memory-grant": memoryGrant(cwd, "session", "memory-route-test") },
    payload: { operation: "append", content: { ...content(),
      sources: [{ kind: "message", locator: "invented" }] } },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toContain("Enable Settings → Memory");
});
it("uses one API and leaves retired user data untouched", async () => {
  const old = join(cwd, ".pi-science", "memory");
  await mkdir(old);
  await writeFile(join(old, "ledger.json"), "old backup");
  expect(
    (
      await request("POST", "/records", {
        ownerId: "mallory",
        origin: "agent_tool",
        content: content(),
      })
    ).json().record,
  ).toMatchObject({
    ownerId: "local-owner",
    origin: "user_manual",
    status: "active",
  });
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/project-knowledge/items?cwd=" + encodeURIComponent(cwd),
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/project-memory/overview?cwd=" + encodeURIComponent(cwd),
      })
    ).statusCode,
  ).toBe(404);
  expect(await readFile(join(old, "ledger.json"), "utf8")).toBe("old backup");
});
it("rejects invalid settings and stale CAS without losing stored settings", async () => {
  const s = (await request("GET", "/settings")).json();
  const { revision, ...rest } = s;
  expect(
    (
      await request("PATCH", "/settings", {
        expectedRevision: revision,
        settings: {
          ...rest,
          review: { mode: "all_manual", scientificClaimsRequireHuman: false },
        },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await request("PATCH", "/settings", {
        expectedRevision: 0,
        settings: rest,
      })
    ).statusCode,
  ).toBe(409);
  expect((await request("GET", "/settings")).json().revision).toBe(revision);
});
it("requires an existing source for science and rejects approval after evidence changed", async () => {
  await writeFile(join(cwd, "result.txt"), "measurement 1");
  const c = {
    ...content("Experimental result is preliminary", "finding"),
    sources: [{ kind: "file", locator: "result.txt" }],
  };
  const r = (await request("POST", "/records", { content: c })).json().record;
  expect(r.status).toBe("pending_review");
  expect(r.sources[0].digest).toMatch(/^[a-f0-9]{64}$/);
  await writeFile(join(cwd, "result.txt"), "measurement 2");
  expect(
    (
      await request("POST", `/records/${r.id}/approve`, {
        expectedRevision: r.revision,
        contentHash: r.contentHash,
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await request("POST", "/records", {
        content: { ...c, sources: [{ kind: "run", locator: "invented" }] },
      })
    ).statusCode,
  ).toBe(400);
});
it("scope ownership and review cannot be supplied by the model", async () => {
  expect(
    (
      await request("POST", "/agent/write", {
        actor: "user",
        content: content(),
      })
    ).statusCode,
  ).toBe(403);
  const token = memoryGrant(cwd, "session", "secret");
  expect(verifyMemoryGrant(token, "secret")).toEqual({
    cwd,
    sessionId: "session",
  });
  expect(() => verifyMemoryGrant(token, "wrong")).toThrow();
  const r = (await request("POST", "/records", { content: content() })).json()
    .record;
  expect(
    (
      await request("PATCH", `/records/${r.id}`, {
        expectedRevision: r.revision + 1,
        contentHash: r.contentHash,
        content: content("用户偏好英文"),
      })
    ).statusCode,
  ).toBe(409);
});
it("keeps project documents independent of Memory and exports history", async () => {
  await app.inject({
    method: "PUT",
    url: "/api/project/document?cwd=" + encodeURIComponent(cwd),
    payload: { content: "# Project goal" },
  });
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/project/document?cwd=" + encodeURIComponent(cwd),
      })
    ).json().content,
  ).toBe("# Project goal");
  const r = (await request("POST", "/records", { content: content() })).json()
    .record;
  const data = (await request("GET", "/export")).json();
  expect(data.records).toHaveLength(1);
  expect(data.history[0].revisions[0].id).toBe(r.id);
});

it("loads and saves owner-wide Memory settings without a project or a phantom schedule", async () => {
  const global = await app.inject({
    method: "GET",
    url: "/api/memory/settings",
  });
  expect(global.statusCode).toBe(200);
  const { revision, ...settings } = global.json();
  settings.review.mode = "all_manual";
  const saved = await app.inject({
    method: "PATCH",
    url: "/api/memory/settings",
    payload: { expectedRevision: revision, settings },
  });
  expect(saved.statusCode).toBe(200);
  expect((await request("GET", "/settings")).json()).toMatchObject({
    revision: revision + 1,
    review: { mode: "all_manual" },
  });
  expect(
    await modules.stateStore.get(
      "SELECT COUNT(*) count FROM memory_dream_schedules WHERE project_id='' OR cwd=''",
    ),
  ).toEqual({ count: 0 });
});
it("registers project scheduling without extending idle time on repeated reads", async () => {
  await request("GET", "/records");
  await modules.stateStore.run(
    "UPDATE memory_dream_schedules SET last_interaction=1",
  );
  await request("GET", "/records");
  expect(
    await modules.stateStore.get(
      "SELECT last_interaction FROM memory_dream_schedules",
    ),
  ).toEqual({ last_interaction: 1 });
});

it("returns validated browse metadata and current proposal content independently of the page", async () => {
  const first = (
    await request("POST", "/records", { content: content() })
  ).json().record;
  await writeFile(join(cwd, "evidence.txt"), "measurement");
  const scientificContent = (body: string) => ({
    ...content(body, "finding"),
    sources: [{ kind: "file", locator: "evidence.txt" }],
  });
  const science = (
    await request("POST", "/records", {
      content: scientificContent("Measured result requires replication"),
    })
  ).json().record;
  const list = (
    await request("GET", "/records?pageSize=1&sort=created_desc")
  ).json();
  expect(list).toMatchObject({ total: 2, page: 1, pageSize: 1, totalPages: 2 });
  expect(list.records).toHaveLength(1);
  const filtered = (
    await request(
      "GET",
      "/records?status=pending_review&kind=finding&scope=project",
    )
  ).json();
  expect(filtered.total).toBe(1);
  expect(filtered.records[0].id).toBe(science.id);
  await request("POST", `/records/${science.id}/approve`, {
    expectedRevision: science.revision,
    contentHash: science.contentHash,
  });
  const approved = (await request("GET", "/records?status=approved")).json();
  expect(approved.total).toBe(1);
  await request("PATCH", `/records/${science.id}`, {
    expectedRevision: science.revision,
    contentHash: science.contentHash,
    content: scientificContent("Revised measured result"),
  });
  const reviews = (await request("GET", "/reviews")).json();
  expect(reviews.proposals[0].current.body).toBe(science.body);
  expect((await request("GET", "/summary")).json().count).toBe(2);
  for (const query of [
    "page=0",
    "pageSize=101",
    "sort=unknown",
    "status=unknown",
  ])
    expect((await request("GET", "/records?" + query)).statusCode).toBe(400);
  expect((await request("GET", `/records/${first.id}`)).statusCode).toBe(200);
});
