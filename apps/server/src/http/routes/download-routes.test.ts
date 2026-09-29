import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app/app.js";
import type { ServerConfig } from "../../config/config.js";
import { ensureProject } from "../../project/project-registry.js";
import { fetchDownloadHop } from "../../security/download-egress.js";

vi.mock("../../security/download-egress.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../security/download-egress.js")>();
  return { ...original, fetchDownloadHop: vi.fn() };
});

const config: ServerConfig = { host: "127.0.0.1", port: 0, corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false, nodeFiles: true, nodePiManager: false, logLevel: "silent" };
let root: string;
let oldHome: string | undefined;
const apps: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  if (oldHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = oldHome;
  if (root) await rm(root, { recursive: true, force: true });
});

describe("download routes", () => {
  it("requires a grant then downloads and publishes through the API", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-download-routes-"));
    oldHome = process.env.PI_SCIENCE_HOME;
    process.env.PI_SCIENCE_HOME = join(root, "state");
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    await ensureProject(cwd);
    const app = buildApp(config); apps.push(app);
    const body = { cwd, session_id: "route-session", url: "https://files.rcsb.org/download/2V40.cif", destination: "structures/2V40.cif" };
    const blocked = await app.inject({ method: "POST", url: "/api/downloads", payload: body });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: "network_access_required", host: "files.rcsb.org" });
    expect(fetchDownloadHop).not.toHaveBeenCalled();
    const grant = await app.inject({ method: "POST", url: "/api/downloads/grants", payload: { cwd, session_id: body.session_id, url: body.url } });
    expect(grant.statusCode).toBe(200);
    vi.mocked(fetchDownloadHop).mockResolvedValue(new Response("data_test\n", { status: 200 }) as any);
    const result = await app.inject({ method: "POST", url: "/api/downloads", payload: body });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ destination: body.destination, size: 10, artifact_version: 1 });
    expect(await readFile(join(cwd, body.destination), "utf8")).toBe("data_test\n");
  });
});
