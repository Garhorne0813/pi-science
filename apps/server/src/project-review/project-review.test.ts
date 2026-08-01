import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app/app.js";
import type { ServerConfig } from "../config/config.js";
import { ProjectReviewService } from "./service.js";
import { parseReviewResult, type ReviewRunRequest, type ReviewRunResult, type ReviewSubagentRunner } from "./types.js";
import { createServerModules } from "../app/server-modules.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

function config(): ServerConfig {
  return { host: "127.0.0.1", port: 0, pythonOrigin: "http://127.0.0.1:1", corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false, nodeFiles: false, nodePiManager: false, logLevel: "silent" };
}

async function workspace(sessionId = "session-a", messages = 2): Promise<string> {
  const cwd = join(tmpdir(), `pi-science-review-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(cwd);
  await mkdir(join(cwd, ".pi-science", "sessions"), { recursive: true });
  const rows = [JSON.stringify({ type: "session", id: sessionId, cwd, timestamp: new Date().toISOString() })];
  for (let index = 0; index < messages; index += 1) {
    rows.push(JSON.stringify({ type: "message", id: `message-${index}`, timestamp: new Date().toISOString(), message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `turn ${index} about buffer pH` }] } }));
  }
  await writeFile(join(cwd, ".pi-science", "sessions", `${sessionId}.jsonl`), `${rows.join("\n")}\n`, "utf8");
  return realpath(cwd);
}

async function readState(cwd: string): Promise<{ items: Array<Record<string, unknown>>; proposals: Array<Record<string, unknown>>; policy: Record<string, unknown> }> {
  return JSON.parse(await readFile(join(cwd, ".pi-science", "project-state.json"), "utf8"));
}

class FakeReviewRunner implements ReviewSubagentRunner {
  calls: ReviewRunRequest[] = [];
  gate: Promise<void> = Promise.resolve();
  failure: Error | null = null;

  constructor(private readonly proposals: Array<Record<string, unknown>> = [{ knowledge_type: "finding", title: "Buffer pH drifts above 7.6", summary: "The lysis buffer drifts after 4 hours at room temperature.", reason: "observed twice", confidence: "high", importance: "important", related_files: ["notes.md"], message_ids: ["message-0"] }]) {}

  async run(request: ReviewRunRequest): Promise<ReviewRunResult> {
    this.calls.push(request);
    await this.gate;
    if (this.failure) throw this.failure;
    return { run_id: request.run_id, output: parseReviewResult(JSON.stringify(this.proposals)) };
  }

  async shutdown(): Promise<void> {}
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met before the timeout");
}

describe("project review output parsing", () => {
  it("accepts a bare array, a wrapped object, and markdown-fenced JSON", () => {
    const item = { knowledge_type: "decision", title: "Use HPLC grade water", summary: "Switch to HPLC grade water for all buffers." };
    expect(parseReviewResult(JSON.stringify([item])).proposals).toHaveLength(1);
    expect(parseReviewResult(JSON.stringify({ proposals: [item] })).proposals).toHaveLength(1);
    expect(parseReviewResult("```json\n" + JSON.stringify({ proposals: [item] }) + "\n```").proposals[0]?.knowledge_type).toBe("decision");
    expect(parseReviewResult("Here you go:\n" + JSON.stringify([item]) + "\nThat's all.").proposals).toHaveLength(1);
  });

  it("defaults unknown enum values and rejects unusable output", () => {
    const parsed = parseReviewResult(JSON.stringify([{ knowledge_type: "nonsense", title: "Keep the fridge at 4C", summary: "Reagents degrade above 8C.", confidence: "extreme" }]));
    expect(parsed.proposals[0]).toMatchObject({ knowledge_type: "finding", confidence: "medium", importance: "normal", related_files: [], message_ids: [] });
    expect(() => parseReviewResult("not json at all")).toThrow();
    expect(() => parseReviewResult(JSON.stringify([{ summary: "missing a title" }]))).toThrow();
  });
});

describe("POST /api/project-knowledge/review", () => {
  it("appends pending knowledge proposals and returns the frontend response contract", async () => {
    const cwd = await workspace();
    const runner = new FakeReviewRunner();
    const app = buildApp(config(), { ...createServerModules(config()), projectReview: new ProjectReviewService(runner) });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/api/project-knowledge/review", payload: { cwd, session_id: "session-a", include_files: true, force_full_session: false } });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ created: 1, skipped: 0, proposal_ids: [expect.any(String)], message: expect.any(String), run_id: expect.any(String) });
    expect(runner.calls[0]?.excerpt.messages.map((message) => message.id)).toEqual(["message-0", "message-1"]);

    const state = await readState(cwd);
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]).toMatchObject({
      id: body.proposal_ids[0],
      proposal_type: "knowledge",
      knowledge_type: "finding",
      type: "finding",
      status: "pending",
      title: "Buffer pH drifts above 7.6",
      confidence: "high",
      importance: "important",
      related_files: ["notes.md"],
      source_message_ids: ["message-0"],
      operations: [],
      source: { session_id: "session-a", message_ids: ["message-0"], files: ["notes.md"], run_ids: [], citations: [] },
    });

    const listed = await app.inject({ method: "GET", url: `/api/project-knowledge/proposals?cwd=${encodeURIComponent(cwd)}&status=pending` });
    expect(listed.json().pending_count).toBe(1);
  });

  it("skips proposals whose title already exists and reports the count", async () => {
    const cwd = await workspace();
    const runner = new FakeReviewRunner();
    const review = new ProjectReviewService(runner);
    const app = buildApp(config(), { ...createServerModules(config()), projectReview: review });
    apps.push(app);

    await app.inject({ method: "POST", url: "/api/project-knowledge/review", payload: { cwd, session_id: "session-a" } });
    const second = await app.inject({ method: "POST", url: "/api/project-knowledge/review", payload: { cwd, session_id: "session-a" } });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ created: 0, skipped: 1 });
    expect((await readState(cwd)).proposals).toHaveLength(1);
  });

  it("materializes knowledge items when pending proposals are accepted in a batch", async () => {
    const cwd = await workspace();
    const runner = new FakeReviewRunner([
      { knowledge_type: "finding", title: "Buffer pH drifts", summary: "Observed after four hours." },
      { knowledge_type: "decision", title: "Use fresh buffer", summary: "Prepare buffer before each run." },
    ]);
    const app = buildApp(config(), { ...createServerModules(config()), projectReview: new ProjectReviewService(runner) });
    apps.push(app);

    const reviewed = await app.inject({ method: "POST", url: "/api/project-knowledge/review", payload: { cwd, session_id: "session-a" } });
    const proposalIds = reviewed.json().proposal_ids as string[];
    const accepted = await app.inject({ method: "POST", url: `/api/project-knowledge/proposals/batch?cwd=${encodeURIComponent(cwd)}`, payload: { proposal_ids: proposalIds, action: "accept" } });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ ok: true, failures: [], results: [{ proposal_id: proposalIds[0], status: "accepted" }, { proposal_id: proposalIds[1], status: "accepted" }] });
    const state = await readState(cwd);
    expect(state.proposals.map((proposal) => proposal.status)).toEqual(["accepted", "accepted"]);
    expect(state.items).toHaveLength(2);
    expect(state.items.map((item) => item.proposal_id)).toEqual(proposalIds);
    expect(state.items.map((item) => item.title)).toEqual(["Buffer pH drifts", "Use fresh buffer"]);
  });

  it("recovers accepted knowledge proposals written without corresponding items", async () => {
    const cwd = await workspace();
    const at = new Date().toISOString();
    await writeFile(join(cwd, ".pi-science", "project-state.json"), JSON.stringify({
      items: [],
      proposals: [{
        id: "proposal-legacy-batch",
        proposal_type: "knowledge",
        knowledge_type: "conclusion",
        type: "conclusion",
        title: "Legacy accepted result",
        summary: "This proposal was accepted by the old batch endpoint.",
        reason: "durable result",
        confidence: "high",
        importance: "important",
        status: "accepted",
        source: { session_id: "session-a", message_ids: ["message-0"], files: [], run_ids: [], citations: [] },
        related_files: [],
        conflicts_with: [],
        supersedes: [],
        operations: [],
        created_at: at,
        updated_at: at,
      }],
      project_versions: [],
      policy: { auto_review: false },
      history: [],
    }), "utf8");
    const app = buildApp(config(), { ...createServerModules(config()), projectReview: new ProjectReviewService(new FakeReviewRunner()) });
    apps.push(app);

    const listed = await app.inject({ method: "GET", url: `/api/project-knowledge/items?cwd=${encodeURIComponent(cwd)}` });

    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([expect.objectContaining({ proposal_id: "proposal-legacy-batch", title: "Legacy accepted result", status: "active" })]);
  });

  it("rejects a concurrent review for the same workspace with 409", async () => {
    const cwd = await workspace();
    const runner = new FakeReviewRunner();
    const gate = deferred();
    runner.gate = gate.promise;
    const app = buildApp(config(), { ...createServerModules(config()), projectReview: new ProjectReviewService(runner) });
    apps.push(app);

    const first = app.inject({ method: "POST", url: "/api/project-knowledge/review", payload: { cwd, session_id: "session-a" } });
    await waitFor(() => runner.calls.length === 1);
    const second = await app.inject({ method: "POST", url: "/api/project-knowledge/review", payload: { cwd, session_id: "session-a" } });
    gate.release();

    expect(second.statusCode).toBe(409);
    expect(String(second.json().error)).toContain("already running");
    expect((await first).statusCode).toBe(200);
    expect(runner.calls).toHaveLength(1);
  });

  it("reports a subagent failure without writing proposals and stays usable afterwards", async () => {
    const cwd = await workspace();
    const runner = new FakeReviewRunner();
    runner.failure = new Error("Pi CLI is not configured");
    const review = new ProjectReviewService(runner);
    const app = buildApp(config(), { ...createServerModules(config()), projectReview: review });
    apps.push(app);

    const failed = await app.inject({ method: "POST", url: "/api/project-knowledge/review", payload: { cwd, session_id: "session-a" } });
    expect(failed.statusCode).toBe(500);
    expect(failed.json().error).toBe("Pi CLI is not configured");
    await expect(readState(cwd)).rejects.toThrow();

    runner.failure = null;
    const recovered = await app.inject({ method: "POST", url: "/api/project-knowledge/review", payload: { cwd, session_id: "session-a" } });
    expect(recovered.json()).toMatchObject({ created: 1 });
  });

  it("does not invoke the subagent when there is no session or no history", async () => {
    const cwd = await workspace("session-empty", 0);
    const runner = new FakeReviewRunner();
    const app = buildApp(config(), { ...createServerModules(config()), projectReview: new ProjectReviewService(runner) });
    apps.push(app);

    const withoutSession = await app.inject({ method: "POST", url: "/api/project-knowledge/review", payload: { cwd, session_id: null } });
    const withoutHistory = await app.inject({ method: "POST", url: "/api/project-knowledge/review", payload: { cwd, session_id: "session-empty" } });

    expect(withoutSession.json()).toMatchObject({ created: 0, skipped: 0, proposal_ids: [] });
    expect(withoutHistory.json()).toMatchObject({ created: 0, skipped: 0, proposal_ids: [] });
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects an unregistered workspace", async () => {
    const app = buildApp(config(), { ...createServerModules(config()), projectReview: new ProjectReviewService(new FakeReviewRunner()) });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/project-knowledge/review", payload: { cwd: join(tmpdir(), "pi-science-not-a-workspace") } });
    expect(response.statusCode).toBe(403);
  });
});

describe("project review policy gate", () => {
  it("skips an automatic review when policy.auto_review is disabled", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, ".pi-science", "project-state.json"), JSON.stringify({ items: [], proposals: [], project_versions: [], policy: { auto_review: false }, history: [] }), "utf8");
    const runner = new FakeReviewRunner();
    const review = new ProjectReviewService(runner);

    const summary = await review.run(cwd, { sessionId: "session-a", trigger: "auto" });

    expect(summary).toMatchObject({ created: 0, proposal_ids: [] });
    expect(runner.calls).toHaveLength(0);
    expect((await readState(cwd)).proposals).toHaveLength(0);
  });

  it("skips an automatic review on a fresh workspace: auto_review defaults to off", async () => {
    const cwd = await workspace();
    const runner = new FakeReviewRunner();
    const review = new ProjectReviewService(runner);

    await expect(review.run(cwd, { sessionId: "session-a", trigger: "auto" })).resolves.toMatchObject({ created: 0, proposal_ids: [] });
    expect(runner.calls).toHaveLength(0);
  });

  it("reports auto_review false for an uninitialized workspace and keeps a stored true", async () => {
    const fresh = await workspace();
    const app = buildApp(config(), { ...createServerModules(config()), projectReview: new ProjectReviewService(new FakeReviewRunner()) });
    apps.push(app);

    const initial = await app.inject({ method: "GET", url: `/api/project-knowledge/policy?cwd=${encodeURIComponent(fresh)}` });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().auto_review).toBe(false);

    const optedIn = await workspace("session-b");
    await writeFile(join(optedIn, ".pi-science", "project-state.json"), JSON.stringify({ items: [], proposals: [], project_versions: [], policy: { auto_review: true }, history: [] }), "utf8");
    const stored = await app.inject({ method: "GET", url: `/api/project-knowledge/policy?cwd=${encodeURIComponent(optedIn)}` });
    expect(stored.json().auto_review).toBe(true);
    // The stored opt-in survives an unrelated policy write.
    await app.inject({ method: "PATCH", url: `/api/project-knowledge/policy?cwd=${encodeURIComponent(optedIn)}`, payload: { reminder_threshold: 9 } });
    expect((await readState(optedIn)).policy).toMatchObject({ auto_review: true, reminder_threshold: 9 });
  });

  it("runs an automatic review once the workspace has opted in", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, ".pi-science", "project-state.json"), JSON.stringify({ items: [], proposals: [], project_versions: [], policy: { auto_review: true }, history: [] }), "utf8");
    const runner = new FakeReviewRunner();
    const review = new ProjectReviewService(runner);

    await expect(review.run(cwd, { sessionId: "session-a", trigger: "auto" })).resolves.toMatchObject({ created: 1 });
    expect(runner.calls).toHaveLength(1);
  });

  it("ignores the policy gate for a manual review", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, ".pi-science", "project-state.json"), JSON.stringify({ items: [], proposals: [], project_versions: [], policy: { auto_review: false }, history: [] }), "utf8");
    const runner = new FakeReviewRunner();

    await expect(new ProjectReviewService(runner).run(cwd, { sessionId: "session-a", trigger: "manual" })).resolves.toMatchObject({ created: 1 });
  });
});
