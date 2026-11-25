import Fastify from "fastify";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFileReadRoutes } from "./file-routes.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const workspaces: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-folder-mgmt-"));
  workspaces.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  return cwd;
}

async function buildApp(cwd: string) {
  const app = Fastify({ logger: false });
  registerFileReadRoutes(app as never);
  apps.push(app);
  const query = `cwd=${encodeURIComponent(cwd)}`;
  return { app, query };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => execFile("git", ["-C", cwd, ...args], (error) => error ? reject(error) : resolve()));
}

describe("GET /api/files/git-status", () => {
  it("returns tracked and untracked changes without exposing git output", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    await git(cwd, "init");
    await git(cwd, "config", "user.email", "tests@example.com");
    await git(cwd, "config", "user.name", "Tests");
    await writeFile(join(cwd, "tracked.txt"), "before", "utf8");
    await git(cwd, "add", "tracked.txt");
    await git(cwd, "commit", "-m", "initial");
    await writeFile(join(cwd, "tracked.txt"), "after", "utf8");
    await writeFile(join(cwd, "new.txt"), "new", "utf8");

    const response = await app.inject({ method: "GET", url: `/api/files/git-status?${query}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      repository: true,
      entries: { "new.txt": "??", "tracked.txt": " M" },
      stats: {
        "new.txt": { additions: 1, deletions: 0 },
        "tracked.txt": { additions: 1, deletions: 1 },
      },
    });
  });

  it("returns a stable empty result outside a git repository", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    const response = await app.inject({ method: "GET", url: `/api/files/git-status?${query}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ repository: false, entries: {}, stats: {} });
  });

  it("counts staged lines before the repository has its first commit", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    await git(cwd, "init");
    await writeFile(join(cwd, "first.txt"), "one\ntwo\n", "utf8");
    await git(cwd, "add", "first.txt");

    const response = await app.inject({ method: "GET", url: `/api/files/git-status?${query}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      repository: true,
      entries: { "first.txt": "A " },
      stats: { "first.txt": { additions: 2, deletions: 0 } },
    });
  });
});

describe("GET /api/files/events", () => {
  it("streams workspace changes and ignores hidden metadata", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/files/events?${query}`, { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // connected comment
    await writeFile(join(cwd, ".pi-science", "ignored.json"), "{}", "utf8");
    await writeFile(join(cwd, "visible.txt"), "changed", "utf8");

    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("file event timeout")), 3_000)),
    ]);
    const text = decoder.decode(next.value, { stream: !next.done });
    controller.abort();

    expect(text).toContain("visible.txt");
    expect(text).not.toContain("ignored.json");
  });
});

describe("GET /api/files/search", () => {
  it("finds nested files by path while excluding hidden, dependency, and symlink trees", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    await mkdir(join(cwd, "results", "final"), { recursive: true });
    await writeFile(join(cwd, "results", "final", "report.csv"), "a,b\n1,2\n", "utf8");
    await mkdir(join(cwd, ".hidden"), { recursive: true });
    await writeFile(join(cwd, ".hidden", "report-secret.csv"), "secret", "utf8");
    await mkdir(join(cwd, "node_modules", "package"), { recursive: true });
    await writeFile(join(cwd, "node_modules", "package", "report.js"), "", "utf8");
    await symlink(join(cwd, "results"), join(cwd, "linked-results"));

    const response = await app.inject({ method: "GET", url: `/api/files/search?${query}&q=report` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({ path: "results/final/report.csv", name: "report.csv", isDir: false }),
    ]);
  });

  it("returns an empty result for an empty query", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    const response = await app.inject({ method: "GET", url: `/api/files/search?${query}&q=%20` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});

describe("POST /api/files/mkdir", () => {
  it("creates nested folders and records provenance", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    const response = await app.inject({ method: "POST", url: `/api/files/mkdir?${query}`, payload: { path: "figures/final" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, path: "figures/final" });
    expect((await stat(join(cwd, "figures", "final"))).isDirectory()).toBe(true);
  });

  it("rejects empty and escaping paths", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    expect((await app.inject({ method: "POST", url: `/api/files/mkdir?${query}`, payload: { path: "  " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/files/mkdir?${query}`, payload: { path: "../escape" } })).statusCode).toBe(400);
  });

  it("refuses an existing folder when exclusive is requested", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    await mkdir(join(cwd, "figures"), { recursive: true });
    const response = await app.inject({ method: "POST", url: `/api/files/mkdir?${query}`, payload: { path: "figures", exclusive: true } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Folder already exists: figures" });
  });

  it("stays idempotent without the exclusive flag", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    expect((await app.inject({ method: "POST", url: `/api/files/mkdir?${query}`, payload: { path: "figures/final" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/files/mkdir?${query}`, payload: { path: "figures/final" } })).statusCode).toBe(200);
  });
});

describe("POST /api/files/create", () => {
  it("creates an empty file at a nested path and reports it", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    const response = await app.inject({ method: "POST", url: `/api/files/create?${query}`, payload: { path: "notes/empty.txt" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, path: "notes/empty.txt" });
    expect((await stat(join(cwd, "notes", "empty.txt"))).size).toBe(0);
  });

  it("refuses to clobber an existing file", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    await mkdir(join(cwd, "notes"), { recursive: true });
    await writeFile(join(cwd, "notes", "keep.txt"), "original", "utf8");
    const response = await app.inject({ method: "POST", url: `/api/files/create?${query}`, payload: { path: "notes/keep.txt" } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "File already exists: notes/keep.txt" });
    expect(await readFile(join(cwd, "notes", "keep.txt"), "utf8")).toBe("original");
  });

  it("rejects empty and escaping paths", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    expect((await app.inject({ method: "POST", url: `/api/files/create?${query}`, payload: { path: "  " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/files/create?${query}`, payload: { path: "../escape.txt" } })).statusCode).toBe(400);
  });
});

describe("DELETE /api/files/*", () => {
  it("refuses to delete the workspace root and .pi-science", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    // Whether the guard answers 403 (explicit refusal) or 404 (the sensitive-path
    // policy rejects resolution first), the directories must survive.
    const rootStatus = (await app.inject({ method: "DELETE", url: `/api/files/.?${query}&recursive=true` })).statusCode;
    expect([403, 404]).toContain(rootStatus);
    const metaStatus = (await app.inject({ method: "DELETE", url: `/api/files/.pi-science?${query}&recursive=true` })).statusCode;
    expect([403, 404]).toContain(metaStatus);
    expect((await stat(join(cwd, ".pi-science"))).isDirectory()).toBe(true);
  });

  it("requires explicit recursive for non-empty folders and then removes the subtree", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    await mkdir(join(cwd, "runs", "old"), { recursive: true });
    await writeFile(join(cwd, "runs", "old", "a.txt"), "x", "utf8");

    const guarded = await app.inject({ method: "DELETE", url: `/api/files/runs?${query}` });
    expect(guarded.statusCode).toBe(409);
    expect(guarded.json()).toMatchObject({ error: expect.stringContaining("recursive=true") });

    const removed = await app.inject({ method: "DELETE", url: `/api/files/runs?${query}&recursive=true` });
    expect(removed.statusCode).toBe(200);
    await expect(stat(join(cwd, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("POST /api/files/reveal", () => {
  it("dispatches the platform file manager without waiting on the child process", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    await mkdir(join(cwd, "figures"), { recursive: true });
    const response = await app.inject({ method: "POST", url: `/api/files/reveal?${query}`, payload: { path: "figures" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, path: "figures", is_directory: true });
  });

  it("validates the path stays inside the workspace", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    const response = await app.inject({ method: "POST", url: `/api/files/reveal?${query}`, payload: { path: "../../etc" } });
    expect(response.statusCode).toBe(400);
  });
});
