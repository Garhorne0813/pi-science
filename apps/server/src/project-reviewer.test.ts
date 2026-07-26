import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import type { ServerConfig } from "./config.js";
import { readState } from "./project-knowledge-store.js";
import { ProjectReviewer, type ReviewerModelRunner } from "./project-reviewer.js";
import { invalidateSessionFileCache } from "./session-repository.js";

const tempDirs: string[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  delete process.env.PI_SCIENCE_WORKSPACES;
});

function config(): ServerConfig {
  return { host: "127.0.0.1", port: 0, pythonOrigin: "http://127.0.0.1:1", corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false, nodeFiles: false, nodePiManager: false, logLevel: "silent" };
}

async function workspace(messages: Array<{ id: string; role: string; text: string }>, sessionId = "session-1"): Promise<string> {
  const path = join(tmpdir(), `pi-science-reviewer-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(path);
  const sessionDir = join(path, ".pi-science", "sessions", "encoded");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `${sessionId}.jsonl`),
    [
      JSON.stringify({ type: "session", id: sessionId, cwd: path, timestamp: "2026-07-26T00:00:00.000Z" }),
      ...messages.map((message, index) => JSON.stringify({
        type: "message",
        id: message.id,
        timestamp: `2026-07-26T00:00:0${index + 1}.000Z`,
        message: { role: message.role, content: [{ type: "text", text: message.text }] },
      })),
    ].join("\n") + "\n",
    "utf8",
  );
  invalidateSessionFileCache(path);
  return path;
}

function runner(...responses: string[]): ReviewerModelRunner & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async run(_cwd: string, prompt: string) {
      prompts.push(prompt);
      return responses[Math.min(prompts.length - 1, responses.length - 1)] ?? "{\"proposals\":[]}";
    },
  };
}

const conversation = [
  { id: "m1", role: "user", text: "Which solvent gave the highest yield?" },
  { id: "m2", role: "assistant", text: "Ethanol reached 82% yield, clearly above the 61% from methanol." },
];

describe("project knowledge reviewer", () => {
  it("turns reviewed messages into pending proposals", async () => {
    const cwd = await workspace(conversation);
    const model = runner(JSON.stringify({
      proposals: [{
        proposal_type: "knowledge",
        knowledge_type: "finding",
        title: "Ethanol outperforms methanol",
        summary: "Ethanol reached 82% yield against 61% for methanol.",
        reason: "Durable experimental comparison",
        confidence: "high",
        importance: "important",
        source_message_ids: ["m2"],
        related_files: [],
      }],
    }));

    const result = await new ProjectReviewer(model).review({ cwd, sessionId: "session-1" });

    expect(result).toMatchObject({ created: 1, skipped: 0 });
    const stored = await readState(cwd);
    expect(stored.proposals).toHaveLength(1);
    expect(stored.proposals[0]).toMatchObject({
      proposal_type: "knowledge",
      knowledge_type: "finding",
      status: "pending",
      title: "Ethanol outperforms methanol",
    });
    expect(stored.proposals[0]!.source).toMatchObject({ session_id: "session-1", message_ids: ["m2"] });
    expect(stored.reviewer_runs).toHaveLength(1);
    expect(stored.reviewer_runs[0]).toMatchObject({ status: "ok", created_count: 1 });
    // The evidence has to reach the model, and only as data.
    expect(model.prompts[0]).toContain("Ethanol reached 82% yield");
    expect(model.prompts[0]).toContain("untrusted data");
  });

  it("rejects proposals that cite invented evidence", async () => {
    const cwd = await workspace(conversation);
    const model = runner(JSON.stringify({
      proposals: [
        { proposal_type: "knowledge", knowledge_type: "finding", title: "Invented source", summary: "s", source_message_ids: ["does-not-exist"], related_files: [] },
        { proposal_type: "knowledge", knowledge_type: "finding", title: "Escaping path", summary: "s", source_message_ids: [], related_files: ["../../etc/passwd"] },
        { proposal_type: "knowledge", knowledge_type: "wild-guess", title: "Bad type", summary: "s", source_message_ids: ["m1"] },
        { proposal_type: "file_operation", title: "Move a file", summary: "s", source_message_ids: ["m1"], operations: [{ type: "move", source: "a", target: "b" }] },
      ],
    }));

    const result = await new ProjectReviewer(model).review({ cwd, sessionId: "session-1" });

    expect(result).toMatchObject({ created: 0, skipped: 4 });
    expect((await readState(cwd)).proposals).toEqual([]);
    const [run] = (await readState(cwd)).reviewer_runs;
    expect(run!.rejected.map((item) => item.reason)).toEqual([
      "proposal cites no reviewed message or existing file",
      "proposal cites no reviewed message or existing file",
      "unsupported knowledge type: wild-guess",
      "only knowledge proposals are supported",
    ]);
  });

  it("reviews incrementally and can be forced to re-read the whole session", async () => {
    const cwd = await workspace(conversation);
    const model = runner("{\"proposals\":[]}");
    const reviewer = new ProjectReviewer(model);

    await reviewer.review({ cwd, sessionId: "session-1" });
    expect((await readState(cwd)).review_cursors["session-1"]).toMatchObject({ message_count: 2, last_message_id: "m2" });

    // Nothing new: the model must not be asked again.
    const second = await reviewer.review({ cwd, sessionId: "session-1" });
    expect(second).toMatchObject({ created: 0, message: "No new session messages to review" });
    expect(model.prompts).toHaveLength(1);

    const forced = await reviewer.review({ cwd, sessionId: "session-1", forceFullSession: true });
    expect(forced.message).toBe("No durable project knowledge found");
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain("Which solvent gave the highest yield?");
  });

  it("drops a proposal that duplicates a pending one", async () => {
    const cwd = await workspace(conversation);
    const proposal = {
      proposal_type: "knowledge",
      knowledge_type: "finding",
      title: "Ethanol outperforms methanol",
      summary: "Ethanol reached 82% yield.",
      source_message_ids: ["m2"],
      related_files: [],
    };
    const model = runner(JSON.stringify({ proposals: [proposal] }));
    const reviewer = new ProjectReviewer(model);

    await reviewer.review({ cwd, sessionId: "session-1" });
    const again = await reviewer.review({ cwd, sessionId: "session-1", forceFullSession: true });

    expect(again).toMatchObject({ created: 0, skipped: 1 });
    expect((await readState(cwd)).proposals).toHaveLength(1);
  });

  it("records the failure and keeps the cursor when the model misbehaves", async () => {
    const cwd = await workspace(conversation);
    const reviewer = new ProjectReviewer(runner("I could not do that."));

    await expect(reviewer.review({ cwd, sessionId: "session-1" })).rejects.toThrow(/no JSON object/i);

    const stored = await readState(cwd);
    expect(stored.reviewer_runs[0]).toMatchObject({ status: "error" });
    // A failed run must be retryable, so the cursor stays where it was.
    expect(stored.review_cursors["session-1"]).toBeUndefined();
  });

  it("serves the review endpoint natively instead of proxying it", async () => {
    const cwd = await workspace(conversation);
    process.env.PI_SCIENCE_WORKSPACES = cwd;
    const app = buildApp(config());
    apps.push(app);

    const missing = await app.inject({ method: "POST", url: "/api/project-knowledge/review", payload: { cwd, session_id: "nope" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["x-pi-science-upstream"]).toBeUndefined();

    const outside = await app.inject({ method: "POST", url: "/api/project-knowledge/review", payload: { cwd: join(tmpdir(), "not-a-workspace") } });
    expect(outside.statusCode).toBe(403);
  });
});
