import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import type { ServerConfig } from "./config.js";
import { nodeSessionService } from "./node-session-service.js";
import { ResearchRepository } from "./research-loop/repository.js";
import { createServerModules } from "./server-modules.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  delete process.env.PI_SCIENCE_HOME;
  delete process.env.PI_SCIENCE_WORKSPACES;
});

function config(): ServerConfig {
  return { host: "127.0.0.1", port: 0, pythonOrigin: "http://127.0.0.1:1", corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false, nodeFiles: true, nodePiManager: false, logLevel: "silent" };
}

async function workspace(): Promise<string> {
  const path = join(tmpdir(), `pi-science-business-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(path); await mkdir(join(path, ".pi-science"), { recursive: true }); await mkdir(join(path, ".pi", "skills"), { recursive: true }); return path;
}

describe("native control-plane business routes", () => {
  it("does not overwrite an existing incomplete workspace environment", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".venv"), { recursive: true });
    await writeFile(join(cwd, ".venv", "keep.txt"), "user-owned", "utf8");
    const app = buildApp(config());
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/environments/workspace?cwd=${encodeURIComponent(cwd)}` });

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toContain("incomplete");
    await expect(readFile(join(cwd, ".venv", "keep.txt"), "utf8")).resolves.toBe("user-owned");
  });

  it("provisions an isolated Python environment inside the workspace", async () => {
    const cwd = await workspace();
    const app = buildApp(config());
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/environments/workspace?cwd=${encodeURIComponent(cwd)}`,
    });

    expect(response.statusCode).toBe(200);
    const environment = response.json();
    expect(environment).toMatchObject({
      ready: true,
      workspace: expect.any(String),
      virtual_env: join(environment.workspace, ".venv"),
      python: expect.stringContaining(join(environment.workspace, ".venv")),
      npm: { local_prefix: environment.workspace },
    });
    await expect(access(environment.python)).resolves.toBeUndefined();

    const submitted = await app.inject({
      method: "POST",
      url: `/api/jobs?cwd=${encodeURIComponent(cwd)}`,
      payload: { command: ["python", "-c", "import sys; print(sys.prefix)"] },
    });
    expect(submitted.statusCode).toBe(200);
    let job = submitted.json();
    for (let attempt = 0; attempt < 100 && ["pending", "running"].includes(job.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = (await app.inject({ method: "GET", url: `/api/jobs/${job.job_id}?cwd=${encodeURIComponent(cwd)}` })).json();
    }
    expect(job).toMatchObject({ status: "succeeded" });
    expect(job.stdout.trim()).toBe(environment.virtual_env);
  }, 30_000);

  it("uses Pi runtime model capabilities for workspace settings", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME, "config.json"), JSON.stringify({ model: "openrouter/openai/gpt-5.1", thinking: "xhigh" }), "utf8");
    vi.spyOn(nodeSessionService, "availableModels").mockResolvedValueOnce({
      success: true,
      data: {
        models: [
          { provider: "openrouter", id: "openai/gpt-5.1", name: "GPT-5.1", reasoning: true, contextWindow: 200000, thinkingLevelMap: { xhigh: "xhigh", max: null } },
          { provider: "openrouter", id: "openai/gpt-4o", name: "GPT-4o", reasoning: false },
        ],
      },
    });
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const settings = await app.inject({ method: "GET", url: `/api/settings/config?cwd=${encodeURIComponent(cwd)}` });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({
      model: "openrouter/openai/gpt-5.1",
      model_catalog_source: "pi",
      available_models: [
        { id: "openrouter/openai/gpt-5.1", reasoning: true, thinking_levels: ["off", "minimal", "low", "medium", "high", "xhigh"], context_window: 200000 },
        { id: "openrouter/openai/gpt-4o", reasoning: false, thinking_levels: ["off"] },
      ],
    });
  });

  it("reports the number of valid sessions on workspace cards", async () => {
    const root = join(tmpdir(), `pi-science-workspaces-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const cwd = join(root, "counted-workspace");
    tempDirs.push(root);
    process.env.PI_SCIENCE_WORKSPACES = root;
    // The workspace listing also includes pinned paths from the control home,
    // so an unisolated home leaks the developer's own pinned workspaces here.
    const home = `${root}-home`;
    tempDirs.push(home);
    process.env.PI_SCIENCE_HOME = home;
    await mkdir(join(cwd, ".pi-science", "sessions", "nested"), { recursive: true });
    await writeFile(join(cwd, ".pi-science", "sessions", "one.jsonl"), `${JSON.stringify({ type: "session", id: "one", cwd, timestamp: "2026-07-24T00:00:00.000Z" })}\n`, "utf8");
    await writeFile(join(cwd, ".pi-science", "sessions", "nested", "two.jsonl"), `${JSON.stringify({ type: "session", id: "two", cwd, timestamp: "2026-07-24T01:00:00.000Z" })}\n`, "utf8");
    await writeFile(join(cwd, ".pi-science", "sessions", "invalid.jsonl"), "not a session\n", "utf8");

    const app = buildApp(config());
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/workspaces" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({ name: "counted-workspace", path: cwd, session_count: 2 }),
    ]);
    expect(response.json()[0].last_modified).not.toBe("");
  });

  it("installs a demo workspace from the shipped assets and reuses it on a repeat install", async () => {
    const root = join(tmpdir(), `pi-science-demo-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tempDirs.push(root);
    process.env.PI_SCIENCE_WORKSPACES = root;
    const home = `${root}-home`; tempDirs.push(home); process.env.PI_SCIENCE_HOME = home;
    const app = buildApp(config());
    apps.push(app);

    const installed = await app.inject({ method: "POST", url: "/api/workspaces/demo?name=molecules" });
    expect(installed.statusCode).toBe(200);
    expect(installed.json()).toMatchObject({ name: "Molecular Playground", path: join(root, "Molecular Playground"), session_count: 0 });
    const path = installed.json().path as string;
    expect((await stat(join(path, ".pi-science"))).isDirectory()).toBe(true);
    expect((await stat(join(path, "data", "1LYS.pdb"))).isFile()).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/workspaces" })).json()).toEqual([
      expect.objectContaining({ name: "Molecular Playground" }),
    ]);

    // A repeat click opens the existing workspace; user edits are never overwritten.
    await writeFile(join(path, "data", "1LYS.pdb"), "edited by the user", "utf8");
    const again = await app.inject({ method: "POST", url: "/api/workspaces/demo?name=molecules" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ path });
    await expect(readFile(join(path, "data", "1LYS.pdb"), "utf8")).resolves.toBe("edited by the user");

    const climate = await app.inject({ method: "POST", url: "/api/workspaces/demo?name=climate" });
    expect(climate.statusCode).toBe(200);
    expect(climate.json()).toMatchObject({ name: "Climate Trends" });
    expect((await stat(join(root, "Climate Trends", "monthly_global_anomalies.csv"))).isFile()).toBe(true);
  });

  it("rejects a demo name that is not on the allowlist", async () => {
    const root = join(tmpdir(), `pi-science-demo-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tempDirs.push(root);
    process.env.PI_SCIENCE_WORKSPACES = root;
    const app = buildApp(config());
    apps.push(app);

    for (const name of ["", "unknown", "../../etc", "..%2F..%2Fetc", "demo-molecules"]) {
      const response = await app.inject({ method: "POST", url: `/api/workspaces/demo?name=${encodeURIComponent(name)}` });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Unknown demo");
    }
    await expect(stat(root)).rejects.toThrow();
  });

  it("persists jobs, artifacts, provenance, and redacts settings secrets", async () => {
    const cwd = await workspace();
    const home = join(cwd, "control-home"); process.env.PI_SCIENCE_HOME = home;
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
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

  it("streams research record invalidation events over SSE", async () => {
    const cwd = await workspace(); const app = buildApp(config()); apps.push(app);
    const response = await app.inject({ method: "GET", url: `/api/project-memory/research-events?cwd=${encodeURIComponent(cwd)}`, payloadAsStream: true });
    try {
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/event-stream");
      let text = ""; let notify: (() => void) | null = null;
      response.stream().on("data", (chunk: Buffer) => { text += String(chunk); notify?.(); });
      const readUntil = async (marker: string) => {
        const deadline = Date.now() + 8_000;
        while (!text.includes(marker)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(marker)}; received: ${JSON.stringify(text)}`);
          await new Promise<void>((resolve) => { notify = resolve; setTimeout(resolve, 50); });
        }
        return text;
      };
      await readUntil(": connected\n\n");
      // The route subscribes under the realpath'd workspace (validateWorkspaceCwd),
      // so emit through a repository keyed the same way.
      await new ResearchRepository(await realpath(cwd)).append("loop.created", { title: "SSE smoke" }, { loop_id: "loop-sse" });
      const received = await readUntil("research.record");
      expect(received).toContain(`data: ${JSON.stringify({ type: "research.record", loop_id: "loop-sse", record_type: "loop.created" })}\n\n`);
    } finally {
      response.raw.res.destroy();
    }
  }, 15_000);

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
    const payload = { name: "Local Provider", base_url: "http://127.0.0.1:11434/v1", api: "openai-completions", models: ["local-model"], reasoning: true, context_window: 64000 };
    expect((await app.inject({ method: "PUT", url: "/api/settings/custom-providers/local-provider", payload })).statusCode).toBe(200);
    const settings = (await app.inject({ method: "GET", url: "/api/settings/config" })).json();
    expect(settings.available_models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "custom-local-provider/local-model", reasoning: true, context_window: 64000, thinking_levels: expect.arrayContaining(["high", "xhigh"]) }),
    ]));
    const compaction = await app.inject({ method: "PUT", url: "/api/settings/compaction", payload: { enabled: true, threshold_percent: 82 } });
    expect(compaction.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/settings/config" })).json()).toMatchObject({ compaction_enabled: true, compaction_threshold_percent: 82 });
    expect((await app.inject({ method: "PUT", url: "/api/settings/compaction", payload: { enabled: true, threshold_percent: 99 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/settings/custom-providers/Local%20Provider", payload })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: "/api/settings/custom-providers/local-provider", payload: { ...payload, models: ["updated-model"] } })).statusCode).toBe(200);
  });

  it("toggles compaction enabled without a threshold while keeping strict threshold validation", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    const app = buildApp(config()); apps.push(app);
    expect((await app.inject({ method: "PUT", url: "/api/settings/compaction", payload: { enabled: true, threshold_percent: 82 } })).statusCode).toBe(200);
    const disabled = await app.inject({ method: "PUT", url: "/api/settings/compaction", payload: { enabled: false } });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ ok: true, compaction_enabled: false, compaction_threshold_percent: 82 });
    expect((await app.inject({ method: "GET", url: "/api/settings/config" })).json()).toMatchObject({ compaction_enabled: false, compaction_threshold_percent: 82 });
    expect((await app.inject({ method: "PUT", url: "/api/settings/compaction", payload: { enabled: true, threshold_percent: 98 } })).statusCode).toBe(400);
  });

  it("clamps the derived compaction threshold for large context windows", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME, "config.json"), JSON.stringify({ model: "google/gemini-2.5-pro" }), "utf8");
    vi.spyOn(nodeSessionService, "availableModels").mockResolvedValueOnce({
      success: true,
      data: { models: [{ provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true, contextWindow: 1_000_000, thinkingLevelMap: {} }] },
    });
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const settings = await app.inject({ method: "GET", url: `/api/settings/config?cwd=${encodeURIComponent(cwd)}` });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ model: "google/gemini-2.5-pro", compaction_threshold_percent: 95 });
  });

  it("returns a non-ok response when persisted settings cannot reload Pi runtimes", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    vi.spyOn(nodeSessionService, "reloadConfiguration").mockRejectedValueOnce(new Error("forced reload failure"));
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const response = await app.inject({ method: "PUT", url: "/api/settings/api-key", payload: { provider: "openai", api_key: "saved-secret" } });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ ok: false, error: expect.stringContaining("forced reload failure") });
    expect((await app.inject({ method: "GET", url: "/api/settings/config" })).json().api_keys).toMatchObject({ openai: true });
  });

  it("blocks SSRF targets and validates subagent workspace access", async () => {
    const cwd = await workspace();
    const app = buildApp(config()); apps.push(app);
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(join(cwd, ".pi", "agents", "reviewer.md"), "# reviewer", "utf8");

    const blocked = await app.inject({ method: "POST", url: "/api/settings/custom-providers/discover", payload: { base_url: "http://127.0.0.1:11434/v1", api_key: "secret" } });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.body).not.toContain("secret");

    const agents = await app.inject({ method: "GET", url: `/api/settings/subagents?cwd=${encodeURIComponent(cwd)}` });
    expect(agents.statusCode).toBe(200);
    expect(agents.json()).toEqual({ agents: [{ name: "reviewer", path: ".pi/agents/reviewer.md" }] });

    const outside = await app.inject({ method: "GET", url: "/api/settings/subagents?cwd=/tmp" });
    expect(outside.statusCode).toBe(403);
  });

  it("rejects job path traversal and preserves cancellation", async () => {
    const cwd = await workspace();
    const app = buildApp(config()); apps.push(app);
    const traversal = await app.inject({ method: "GET", url: `/api/jobs/${encodeURIComponent("../config")}?cwd=${encodeURIComponent(cwd)}` });
    expect(traversal.statusCode).toBe(400);

    const submitted = await app.inject({ method: "POST", url: `/api/jobs?cwd=${encodeURIComponent(cwd)}`, payload: { command: [process.execPath, "-e", "setTimeout(() => process.stdout.write('late'), 500)"], requirement: { timeout_seconds: 10 } } });
    expect(submitted.statusCode).toBe(200);
    const jobId = submitted.json().job_id as string;
    const cancelled = await app.inject({ method: "DELETE", url: `/api/jobs/${jobId}?cwd=${encodeURIComponent(cwd)}` });
    expect(cancelled.statusCode).toBe(200);
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = (await app.inject({ method: "GET", url: `/api/jobs/${jobId}?cwd=${encodeURIComponent(cwd)}` })).json();
      if (!["pending", "running"].includes(current.status)) { expect(current.status).toBe("cancelled"); return; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("cancelled job did not reach a terminal state");
  });

  it("rejects invalid claim-check bounds and serializes provenance versions", async () => {
    const cwd = await workspace();
    const app = buildApp(config()); apps.push(app);
    const invalid = await app.inject({ method: "POST", url: "/api/artifacts/claim-check", payload: { claim: "x", values: [1], minimum: "not-a-number" } });
    expect(invalid.statusCode).toBe(422);
    const reversed = await app.inject({ method: "POST", url: "/api/artifacts/claim-check", payload: { claim: "x", values: [1], minimum: 3, maximum: 2 } });
    expect(reversed.statusCode).toBe(422);

    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => app.inject({ method: "POST", url: `/api/provenance/record?cwd=${encodeURIComponent(cwd)}`, payload: { path: "result.txt", tool: `test-${index}` } })));
    expect(results.every((response) => response.statusCode === 200)).toBe(true);
    const versions = results.map((response) => response.json().version).sort((a: number, b: number) => a - b);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
