import Fastify from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerNotebookArtifactRoutes } from "./notebook-artifact-routes.js";
import { ensureProject } from "../../project/project-registry.js";
import { MAX_CODE_BYTES } from "../../runtime/notebook/chat-notebook-service.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-notebook-routes-"));
  tempDirs.push(cwd);
  await mkdir(join(cwd, ".pi-science", "sessions"), { recursive: true });
  await ensureProject(cwd);
  return cwd;
}

function sessionHeader(id: string, cwd: string) {
  return `${JSON.stringify({ type: "session", id, cwd, timestamp: "2026-08-01T00:00:00.000Z" })}\n`;
}

function messageLine(id: string, role: string, text: string) {
  return `${JSON.stringify({ type: "message", id, timestamp: "2026-08-01T00:00:01.000Z", message: { role, content: [{ type: "text", text }] } })}\n`;
}

const SESSION = "019f0000-0000-7000-8000-000000000002";
const ASSISTANT = "msg-assistant";

async function writeSession(cwd: string): Promise<void> {
  await writeFile(
    join(cwd, ".pi-science", "sessions", "session-a.jsonl"),
    sessionHeader(SESSION, cwd) + messageLine("msg-user", "user", "你好") + messageLine(ASSISTANT, "assistant", "我来分析。"),
    "utf8",
  );
}

function body(): Record<string, unknown> {
  return {
    session_id: SESSION,
    message_id: ASSISTANT,
    source_line: "L1-L5",
    language: "python",
    code: "print('hi')\n",
    result: { ok: true, stdout: "hi\n", result: null, error: null },
    model_at_save: "custom-gpt/gpt-5.6-luna",
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("POST /api/artifacts/notebooks/save", () => {
  it("creates the notebook on first save and increments provenance revision on subsequent saves", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const app = Fastify();
    registerNotebookArtifactRoutes(app);

    const first = await app.inject({ method: "POST", url: `/api/artifacts/notebooks/save?cwd=${encodeURIComponent(cwd)}`, payload: body() });
    expect(first.statusCode).toBe(200);
    const firstJson = first.json();
    expect(firstJson).toMatchObject({
      ok: true,
      created_notebook: true,
      appended: true,
      updated: false,
      cell_count: 2,
      path: `notebooks/chat-${SESSION}-analysis.ipynb`,
      revision: 1,
    });

    const second = await app.inject({ method: "POST", url: `/api/artifacts/notebooks/save?cwd=${encodeURIComponent(cwd)}`, payload: body() });
    expect(second.statusCode).toBe(200);
    const secondJson = second.json();
    expect(secondJson).toMatchObject({ ok: true, appended: false, updated: true, cell_count: 2, revision: 2 });
  });

  it("rejects an invalid workspace with 403", async () => {
    const app = Fastify({ bodyLimit: 11 * 1024 * 1024 });
    registerNotebookArtifactRoutes(app);
    const response = await app.inject({ method: "POST", url: "/api/artifacts/notebooks/save?cwd=/tmp/not-a-workspace-xyz", payload: body() });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ ok: false, code: "workspace_invalid" });
  });

  it("rejects missing code with 400", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const app = Fastify({ bodyLimit: 11 * 1024 * 1024 });
    registerNotebookArtifactRoutes(app);
    const response = await app.inject({ method: "POST", url: `/api/artifacts/notebooks/save?cwd=${encodeURIComponent(cwd)}`, payload: { ...body(), code: "" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, code: "invalid_request" });
  });

  it("rejects unknown session/message with 404", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const app = Fastify({ bodyLimit: 11 * 1024 * 1024 });
    registerNotebookArtifactRoutes(app);
    const missingSession = await app.inject({ method: "POST", url: `/api/artifacts/notebooks/save?cwd=${encodeURIComponent(cwd)}`, payload: { ...body(), session_id: "nope" } });
    expect(missingSession.statusCode).toBe(404);
    const missingMessage = await app.inject({ method: "POST", url: `/api/artifacts/notebooks/save?cwd=${encodeURIComponent(cwd)}`, payload: { ...body(), message_id: "nope" } });
    expect(missingMessage.statusCode).toBe(404);
  });

  it("rejects oversized code with 413", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const app = Fastify({ bodyLimit: 11 * 1024 * 1024 });
    registerNotebookArtifactRoutes(app);
    const response = await app.inject({ method: "POST", url: `/api/artifacts/notebooks/save?cwd=${encodeURIComponent(cwd)}`, payload: { ...body(), code: "x".repeat(MAX_CODE_BYTES + 1) } });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ ok: false, code: "code_too_large" });
  });

  it("rejects an existing non-notebook file with 409 without overwriting it", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    await mkdir(join(cwd, "notebooks"), { recursive: true });
    await writeFile(join(cwd, "notebooks", `chat-${SESSION}-analysis.ipynb`), "junk", "utf8");
    const app = Fastify({ bodyLimit: 11 * 1024 * 1024 });
    registerNotebookArtifactRoutes(app);
    const response = await app.inject({ method: "POST", url: `/api/artifacts/notebooks/save?cwd=${encodeURIComponent(cwd)}`, payload: body() });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ ok: false, code: "conflict" });
  });
});
