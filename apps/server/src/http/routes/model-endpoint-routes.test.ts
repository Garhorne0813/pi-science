import Fastify from "fastify";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerModelEndpointRoutes } from "./model-endpoint-routes.js";

const originalHome = process.env.PI_SCIENCE_HOME;
const tempDirs: string[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = originalHome;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function appWith(probeHealth?: (url: string) => Promise<{ ok: boolean }>) {
  const home = await mkdtemp(join(tmpdir(), "pi-science-model-endpoint-routes-"));
  tempDirs.push(home);
  process.env.PI_SCIENCE_HOME = home;
  const app = Fastify({ logger: false });
  registerModelEndpointRoutes(app, probeHealth ? { probeHealth } : {});
  apps.push(app);
  return { app, home };
}

describe("model endpoint routes", () => {
  it("creates, lists, deduplicates by identity, and rejects invalid payloads", async () => {
    const { app, home } = await appWith();
    const created = await app.inject({ method: "POST", url: "/api/endpoints", payload: { name: "Local vLLM", base_url: "http://127.0.0.1:8000/v1/", protocol: "openai-completions" } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: "Local vLLM", base_url: "http://127.0.0.1:8000/v1", enabled: true, health: "unknown", data_egress: "remote" });

    const again = await app.inject({ method: "POST", url: "/api/endpoints", payload: { name: "Local vLLM", base_url: "http://127.0.0.1:8000/v1" } });
    expect(again.json().endpoint_id).toBe(created.json().endpoint_id);
    const list = await app.inject({ method: "GET", url: "/api/endpoints" });
    expect(list.json().endpoints).toHaveLength(1);

    const invalid = await app.inject({ method: "POST", url: "/api/endpoints", payload: { name: "", base_url: "ftp://nope" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain("absolute http(s)");

    const stored = JSON.parse(await readFile(join(home, "model-endpoints.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.endpoint_id).toBe(created.json().endpoint_id);
  });

  it("toggles enabled state and probes health with injected fetch", async () => {
    const { app } = await appWith(async (url) => ({ ok: url === "http://ready.example" }));
    const created = (await (await app.inject({ method: "POST", url: "/api/endpoints", payload: { name: "ep", base_url: "http://ready.example" } })).json()) as { endpoint_id?: string };
    expect(created.endpoint_id).toBeTruthy();

    const healthy = await app.inject({ method: "POST", url: `/api/endpoints/${created.endpoint_id}/health` });
    expect(healthy.json()).toMatchObject({ health: "ready", error: null });

    const disabled = await app.inject({ method: "PUT", url: `/api/endpoints/${created.endpoint_id}/enabled?enabled=false` });
    expect(disabled.json()).toMatchObject({ enabled: false, health: "blocked" });

    const blocked = await app.inject({ method: "POST", url: `/api/endpoints/${created.endpoint_id}/health` });
    expect(blocked.json()).toMatchObject({ health: "blocked", error: "endpoint disabled" });

    const reEnabled = await app.inject({ method: "PUT", url: `/api/endpoints/${created.endpoint_id}/enabled` });
    expect(reEnabled.json()).toMatchObject({ enabled: true, health: "blocked" });

    const degraded = await app.inject({ method: "POST", url: "/api/endpoints", payload: { name: "down", base_url: "http://down.example" } });
    const downHealth = await app.inject({ method: "POST", url: `/api/endpoints/${degraded.json().endpoint_id}/health` });
    expect(downHealth.json().health).toBe("degraded");
  });

  it("maps probe failures to health error and unknown ids to 404", async () => {
    const { app } = await appWith(async () => { throw new Error("connection refused"); });
    const created = (await (await app.inject({ method: "POST", url: "/api/endpoints", payload: { name: "ep", base_url: "http://unreachable.example" } })).json()) as { endpoint_id?: string };
    if (!created.endpoint_id) throw new Error("endpoint creation failed");
    const failed = await app.inject({ method: "POST", url: `/api/endpoints/${created.endpoint_id}/health` });
    expect(failed.json().health).toBe("error");
    expect(failed.json().error).toBe("connection refused");

    const missing = await app.inject({ method: "PUT", url: "/api/endpoints/nope/enabled" });
    expect(missing.statusCode).toBe(404);
    const missingHealth = await app.inject({ method: "POST", url: "/api/endpoints/nope/health" });
    expect(missingHealth.statusCode).toBe(404);
  });
});
