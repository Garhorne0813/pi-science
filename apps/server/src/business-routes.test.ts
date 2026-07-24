import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import type { ServerConfig } from "./config.js";
import { nodeSessionService } from "./node-session-service.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  delete process.env.PI_SCIENCE_HOME;
});

function config(): ServerConfig {
  return { host: "127.0.0.1", port: 0, pythonOrigin: "http://127.0.0.1:1", corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false, nodeFiles: true, nodePiManager: false, logLevel: "silent" };
}

async function workspace(): Promise<string> {
  const path = join(tmpdir(), `pi-science-business-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(path); await mkdir(join(path, ".pi-science"), { recursive: true }); await mkdir(join(path, ".pi", "skills"), { recursive: true }); return path;
}

describe("native control-plane business routes", () => {
  it("persists jobs, artifacts, provenance, and redacts settings secrets", async () => {
    const cwd = await workspace();
    const home = join(cwd, "control-home"); process.env.PI_SCIENCE_HOME = home;
    const app = buildApp(config()); apps.push(app);
    const key = await app.inject({ method: "PUT", url: "/api/settings/api-key", payload: { provider: "openai", api_key: "secret-value" } });
    expect(key.statusCode).toBe(200);
    const settings = await app.inject({ method: "GET", url: "/api/settings/config" });
    expect(settings.json()).toMatchObject({ api_keys: { openai: true } });
    expect(settings.body).not.toContain("secret-value");

    const custom = await app.inject({
      method: "PUT",
      url: "/api/settings/custom-providers/smoke-provider",
      payload: { name: "Smoke Provider", base_url: "https://llm.example.com/v1", api_key: "custom-secret", api: "openai-completions", models: ["smoke-model"] },
    });
    expect(custom.statusCode).toBe(200);
    expect(custom.body).not.toContain("custom-secret");
    expect((await app.inject({ method: "GET", url: "/api/settings/config" })).json().available_models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "custom-smoke-provider/smoke-model" }),
    ]));
    expect((await app.inject({ method: "DELETE", url: "/api/settings/custom-providers/smoke-provider" })).statusCode).toBe(200);

    const job = await app.inject({ method: "POST", url: `/api/jobs?cwd=${encodeURIComponent(cwd)}`, payload: { command: [process.execPath, "-e", "process.stdout.write('smoke-job')"] } });
    expect(job.statusCode).toBe(200);
    const jobId = job.json().job_id as string;
    let final = job.json();
    for (let attempt = 0; attempt < 20 && ["pending", "running"].includes(final.status); attempt++) { await new Promise((resolve) => setTimeout(resolve, 20)); final = (await app.inject({ method: "GET", url: `/api/jobs/${jobId}?cwd=${encodeURIComponent(cwd)}` })).json(); }
    expect(final.status).toBe("succeeded");
    expect(final.stdout).toBe("smoke-job");

    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(cwd, "result.txt"), "artifact", "utf8"));
    const artifact = await app.inject({ method: "POST", url: `/api/artifacts/publish?cwd=${encodeURIComponent(cwd)}`, payload: { path: "result.txt", session_id: "s1" } });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.json()).toMatchObject({ path: "result.txt", version: 1 });
    const provenance = await app.inject({ method: "GET", url: `/api/provenance?cwd=${encodeURIComponent(cwd)}` });
    expect(provenance.json().records.length).toBeGreaterThan(0);
  });

  it("supports atomic file writes and research-loop state transitions", async () => {
    const cwd = await workspace(); const app = buildApp(config()); apps.push(app);
    const upload = await app.inject({ method: "POST", url: `/api/files/upload?cwd=${encodeURIComponent(cwd)}`, payload: { filename: "uploaded.txt", content: "hello" } });
    expect(upload.statusCode).toBe(200);
    const move = await app.inject({ method: "POST", url: `/api/files/rename?cwd=${encodeURIComponent(cwd)}`, payload: { source: "uploaded.txt", target: "renamed.txt" } });
    expect(move.statusCode).toBe(200);
    expect(await readFile(join(cwd, "renamed.txt"), "utf8")).toBe("hello");
    const remove = await app.inject({ method: "DELETE", url: `/api/files/renamed.txt?cwd=${encodeURIComponent(cwd)}` });
    expect(remove.statusCode).toBe(200);
    await expect(stat(join(cwd, "renamed.txt"))).rejects.toThrow();

    const loop = await app.inject({ method: "POST", url: `/api/project-memory/research-loops?cwd=${encodeURIComponent(cwd)}`, payload: { title: "Smoke loop", objective: "Verify state" } });
    expect(loop.statusCode).toBe(200);
    const loopId = loop.json().loop_id as string;
    expect((await app.inject({ method: "POST", url: `/api/project-memory/research-loops/${loopId}/start?cwd=${encodeURIComponent(cwd)}` })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/project-memory/research-loops/${loopId}/cancel?cwd=${encodeURIComponent(cwd)}` })).statusCode).toBe(200);
    const listed = await app.inject({ method: "GET", url: `/api/project-memory/research-loops?cwd=${encodeURIComponent(cwd)}` });
    expect(listed.json().loops[0]).toMatchObject({ loop_id: loopId, status: "cancelled" });
  });

  it("preserves exact multipart upload bytes and supports nested destination paths", async () => {
    const cwd = await workspace(); const app = buildApp(config()); apps.push(app);
    const boundary = "----pi-science-upload-boundary";
    const payload = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="uploaded.txt"',
        "Content-Type: text/plain",
        "",
        "hello",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
      "utf8",
    );
    const upload = await app.inject({
      method: "POST",
      url: `/api/files/upload?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("data/nested/uploaded.txt")}`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(upload.statusCode).toBe(200);
    expect(await readFile(join(cwd, "data", "nested", "uploaded.txt"), "utf8")).toBe("hello");
  });

  it("validates the requested skill directory instead of always scanning project skills", async () => {
    const cwd = await workspace(); const app = buildApp(config()); apps.push(app);
    await mkdir(join(cwd, ".pi", "skills", "good"), { recursive: true });
    await writeFile(join(cwd, ".pi", "skills", "good", "SKILL.md"), "---\nname: good\ndescription: Good skill\n---\n", "utf8");
    await mkdir(join(cwd, "tmp-skill"), { recursive: true });
    await writeFile(join(cwd, "tmp-skill", "SKILL.md"), "not front matter", "utf8");
    const response = await app.inject({ method: "POST", url: `/api/skills/validate?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(join(cwd, "tmp-skill"))}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ valid: false });
    expect(response.json().validations).toHaveLength(1);
  });

  it("serializes concurrent settings updates without losing providers", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    const app = buildApp(config()); apps.push(app);
    const [openai, google] = await Promise.all([
      app.inject({ method: "PUT", url: "/api/settings/api-key", payload: { provider: "openai", api_key: "openai-secret" } }),
      app.inject({ method: "PUT", url: "/api/settings/api-key", payload: { provider: "google", api_key: "google-secret" } }),
    ]);
    expect(openai.statusCode).toBe(200);
    expect(google.statusCode).toBe(200);
    const settings = (await app.inject({ method: "GET", url: "/api/settings/config" })).json();
    expect(settings.api_keys).toMatchObject({ openai: true, google: true });
  });

  it("exposes keyless custom providers and rejects slug collisions without blocking canonical updates", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    const app = buildApp(config()); apps.push(app);
    const payload = { name: "Local Provider", base_url: "http://127.0.0.1:11434/v1", api: "openai-completions", models: ["local-model"] };
    expect((await app.inject({ method: "PUT", url: "/api/settings/custom-providers/local-provider", payload })).statusCode).toBe(200);
    const settings = (await app.inject({ method: "GET", url: "/api/settings/config" })).json();
    expect(settings.available_models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "custom-local-provider/local-model" }),
    ]));
    expect((await app.inject({ method: "PUT", url: "/api/settings/custom-providers/Local%20Provider", payload })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: "/api/settings/custom-providers/local-provider", payload: { ...payload, models: ["updated-model"] } })).statusCode).toBe(200);
  });

  it("returns a non-ok response when persisted settings cannot reload Pi runtimes", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    vi.spyOn(nodeSessionService, "reloadConfiguration").mockRejectedValueOnce(new Error("forced reload failure"));
    const app = buildApp(config()); apps.push(app);
    const response = await app.inject({ method: "PUT", url: "/api/settings/api-key", payload: { provider: "openai", api_key: "saved-secret" } });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ ok: false, error: expect.stringContaining("forced reload failure") });
    expect((await app.inject({ method: "GET", url: "/api/settings/config" })).json().api_keys).toMatchObject({ openai: true });
  });
});
