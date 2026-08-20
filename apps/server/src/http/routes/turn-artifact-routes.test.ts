import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../app/app.js";
import type { ServerConfig } from "../../config/config.js";
import { turnArtifactRepository } from "../../runtime/artifacts/turn-artifact-repository.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  delete process.env.PI_SCIENCE_HOME;
  delete process.env.PI_SCIENCE_WORKSPACES;
});

function config(): ServerConfig {
  return { host: "127.0.0.1", port: 0, corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false, nodeFiles: true, nodePiManager: false, logLevel: "silent" };
}

async function workspace(): Promise<string> {
  const path = join(tmpdir(), `pi-science-turn-routes-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(path);
  await mkdir(join(path, ".pi-science"), { recursive: true });
  return path;
}

describe("turn artifact routes", () => {
  it("returns an empty turn list for a session without records", async () => {
    const cwd = await workspace();
    const app = buildApp(config());
    apps.push(app);
    const response = await app.inject({ method: "GET", url: `/api/sessions/ghost-session/artifacts?cwd=${encodeURIComponent(cwd)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ turns: [] });
  });

  it("returns persisted turn artifacts for the session", async () => {
    const cwd = await workspace();
    await turnArtifactRepository.append(cwd, {
      turn_id: "turn-1", session_id: "session-a", assistant_message_id: "msg-1",
      ended_at: "2026-01-01T00:00:00.000Z",
      artifacts: [{ path: "work/plot.png", kind: "image", mime: "image/png", size: 10 }],
    });
    const app = buildApp(config());
    apps.push(app);
    const response = await app.inject({ method: "GET", url: `/api/sessions/session-a/artifacts?cwd=${encodeURIComponent(cwd)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      turns: [
        { turn_id: "turn-1", session_id: "session-a", assistant_message_id: "msg-1", ended_at: "2026-01-01T00:00:00.000Z", artifacts: [{ path: "work/plot.png", kind: "image", mime: "image/png", size: 10 }] },
      ],
    });
  });

  it("rejects an invalid workspace", async () => {
    const app = buildApp(config());
    apps.push(app);
    const response = await app.inject({ method: "GET", url: `/api/sessions/session-a/artifacts?cwd=${encodeURIComponent("/does/not/exist")}` });
    expect(response.statusCode).toBe(403);
  });
});
