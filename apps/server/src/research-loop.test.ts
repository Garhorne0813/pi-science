import { afterEach, describe, expect, it } from "vitest";
import { access, chmod, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import type { ServerConfig } from "./config.js";
import { JobCoordinator } from "./job-coordinator.js";
import { createServerModules } from "./server-modules.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map(async (path) => {
    await makeRemovable(path);
    await rm(path, { recursive: true, force: true });
  }));
});

async function makeRemovable(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) { await chmod(path, 0o600); return; }
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await makeRemovable(join(path, name));
  } catch { /* already absent */ }
}

function config(): ServerConfig {
  return {
    host: "127.0.0.1", port: 0, pythonOrigin: "http://127.0.0.1:1", corsOrigins: [],
    maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false,
    nodeFiles: true, nodePiManager: false, logLevel: "silent",
  };
}

async function fixture() {
  const cwd = join(tmpdir(), `pi-science-research-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  directories.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  const base = createServerModules(config());
  const jobs = new JobCoordinator({ environment: async () => ({ ...process.env }) });
  const app = buildApp(config(), { ...base, jobs });
  apps.push(app);
  return { app, cwd };
}

describe("research loop MVP", () => {
  it("builds a durable serial propose, execute, evaluate, and frontier lifecycle", async () => {
    const { app, cwd } = await fixture();
    const query = `cwd=${encodeURIComponent(cwd)}`;
    const evaluator = {
      evaluator_id: "quality", version: 1, digest: "sha256:quality-v1", status: "approved",
      metrics: [{ name: "score", direction: "maximize", weight: 1 }],
      hard_checks: ["artifact_verified"],
    };
    expect((await app.inject({ method: "POST", url: `/api/project-memory/evaluators?${query}`, payload: evaluator })).statusCode).toBe(200);

    const created = await app.inject({
      method: "POST", url: `/api/project-memory/research-loops?${query}`,
      payload: {
        title: "Improve score", objective: "Find a better deterministic score",
        evaluator_ref: { evaluator_id: "quality", version: 1, digest: "sha256:quality-v1" },
        stop_conditions: { target_metrics: { score: 0.8 }, patience: 5, min_improvement: 0 },
      },
    });
    expect(created.statusCode).toBe(200);
    const loopId = created.json().loop_id as string;

    const preflight = await app.inject({ method: "POST", url: `/api/project-memory/research-loops/${loopId}/preflight?${query}` });
    expect(preflight.json()).toMatchObject({ ok: true, loop: { status: "ready" } });
    expect((await app.inject({ method: "POST", url: `/api/project-memory/research-loops/${loopId}/start?${query}` })).json()).toMatchObject({ status: "running" });

    const escaped = await app.inject({ method: "POST", url: `/api/project-memory/research-loops/${loopId}/candidates?${query}`, payload: { approach_summary: "escape", entrypoint: "../escape.sh", files: { "../escape.sh": "echo unsafe" } } });
    expect(escaped.statusCode).toBe(400);

    const proposal = {
      approach_summary: "Write a deterministic result",
      entrypoint: "solve.sh",
      idempotency_key: "deterministic-candidate-1",
      files: { "solve.sh": "#!/bin/bash\nset -euo pipefail\necho '{\"score\":0.9}' > \"$PI_SCIENCE_OUTPUT_DIR/result.json\"\n" },
    };
    const proposed = await app.inject({ method: "POST", url: `/api/project-memory/research-loops/${loopId}/candidates?${query}`, payload: proposal });
    expect(proposed.statusCode).toBe(200);
    const candidateId = proposed.json().candidate_id as string;
    const repeated = await app.inject({ method: "POST", url: `/api/project-memory/research-loops/${loopId}/candidates?${query}`, payload: proposal });
    expect(repeated.json().candidate_id).toBe(candidateId);

    const execution = await app.inject({ method: "POST", url: `/api/project-memory/research-loops/${loopId}/candidates/${candidateId}/execute?${query}` });
    expect(execution.statusCode).toBe(200);
    let experiences: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await app.inject({ method: "GET", url: `/api/project-memory/research-loops/${loopId}/experiences?${query}` });
      experiences = response.json().experiences;
      if (experiences[0]?.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(experiences[0]).toMatchObject({ candidate_id: candidateId, status: "succeeded" });
    const outputPath = join(cwd, String((experiences[0]!.execution as Record<string, unknown>).outputs_dir), "result.json");
    await expect(access(outputPath)).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({ score: 0.9 });

    const escapedArtifact = await app.inject({
      method: "POST", url: `/api/project-memory/research-loops/${loopId}/candidates/${candidateId}/evaluate?${query}`,
      payload: { metrics: { score: { value: 0.9, direction: "maximize" } }, hard_checks: { artifact_verified: "passed" }, artifact_refs: [{ path: "../solution.json" }] },
    });
    expect(escapedArtifact.statusCode).toBe(400);

    const evaluated = await app.inject({
      method: "POST", url: `/api/project-memory/research-loops/${loopId}/candidates/${candidateId}/evaluate?${query}`,
      payload: {
        metrics: { score: { value: 0.9, direction: "maximize" } },
        hard_checks: { artifact_verified: "passed" },
        artifact_refs: [{ path: "result.json" }],
      },
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json()).toMatchObject({ status: "passed", evaluation: { status: "passed" } });
    const frontier = await app.inject({ method: "GET", url: `/api/project-memory/research-loops/${loopId}/frontier?${query}` });
    expect(frontier.json().frontier).toHaveLength(1);
    const finalLoop = await app.inject({ method: "GET", url: `/api/project-memory/research-loops/${loopId}?${query}` });
    expect(finalLoop.json()).toMatchObject({ status: "completed", stop_reason: "target_metrics_reached" });

    const records = (await readFile(join(cwd, ".pi-science", "research-records.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((row) => row.loop_id).every((row) => row.correlation_id && row.producer)).toBe(true);
  });

  it("returns a draft intent and blocks preflight without an evaluator", async () => {
    const { app, cwd } = await fixture();
    const query = `cwd=${encodeURIComponent(cwd)}`;
    const intent = await app.inject({ method: "POST", url: `/api/project-memory/research-loop-intents?${query}`, payload: { message: "Compare two analysis methods" } });
    expect(intent.json()).toMatchObject({ requires_confirmation: true, draft: { mode: "serial" }, missing_fields: ["evaluator_ref"] });
    const created = await app.inject({ method: "POST", url: `/api/project-memory/research-loops?${query}`, payload: intent.json().draft });
    const preflight = await app.inject({ method: "POST", url: `/api/project-memory/research-loops/${created.json().loop_id}/preflight?${query}` });
    expect(preflight.json()).toMatchObject({ ok: false, blockers: ["an approved evaluator is required"] });
  });
});
