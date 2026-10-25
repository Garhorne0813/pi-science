import Fastify from "fastify";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCitationRoutes } from "./citation-routes.js";
import type { CitationEvidence, VerifyCitationsResult } from "../../runtime/citations/citation-verify-service.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const workspaces: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-citation-routes-"));
  workspaces.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  return cwd;
}

const evidence = (id: string): CitationEvidence => ({
  kind: "doi", id, status: "found", title: `Paper ${id}`, authors: ["A. Author"], journal: "Nature", year: "2024",
  abstract: "An abstract.", oa_url: null, retracted: false, retraction_note: null, verified_at: new Date().toISOString(),
});

function fakeService() {
  return {
    verify: vi.fn(async (): Promise<VerifyCitationsResult> => ({
      text_sha256: "abc",
      citations: [{ ...evidence("10.1/x"), cached: false }],
    })),
    lookup: vi.fn(async () => [evidence("10.1/x")]),
  };
}

describe("citation routes", () => {
  it("verifies text through the service", async () => {
    const cwd = await makeWorkspace();
    const service = fakeService();
    const app = Fastify({ logger: false });
    registerCitationRoutes(app, service as never);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/citations/verify?cwd=${encodeURIComponent(cwd)}`,
      payload: { text: "Cites 10.1/x here." },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ citations: [{ id: "10.1/x", cached: false }] });
    // Canonicalize with the same function the route uses: on Windows the temp
    // dir can be an 8.3 short path that only fs/promises realpath expands.
    const canonicalCwd = await validateWorkspaceCwd(cwd);
    expect(service.verify).toHaveBeenCalledWith(canonicalCwd, { text: "Cites 10.1/x here." });
  });

  it("rejects empty and oversized texts", async () => {
    const cwd = await makeWorkspace();
    const service = fakeService();
    const app = Fastify({ logger: false });
    registerCitationRoutes(app, service as never);
    apps.push(app);

    const empty = await app.inject({ method: "POST", url: `/api/citations/verify?cwd=${encodeURIComponent(cwd)}`, payload: { text: "  " } });
    expect(empty.statusCode).toBe(400);
    const huge = await app.inject({ method: "POST", url: `/api/citations/verify?cwd=${encodeURIComponent(cwd)}`, payload: { text: "x".repeat(500_001) } });
    expect(huge.statusCode).toBe(413);
  });

  it("looks up cached evidence by composite ids", async () => {
    const cwd = await makeWorkspace();
    const service = fakeService();
    const app = Fastify({ logger: false });
    registerCitationRoutes(app, service as never);
    apps.push(app);

    const response = await app.inject({ method: "GET", url: `/api/citations?cwd=${encodeURIComponent(cwd)}&ids=doi:10.1/x` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ citations: [{ id: "10.1/x", title: "Paper 10.1/x" }] });
  });

  it("rejects unregistered workspaces", async () => {
    const service = fakeService();
    const app = Fastify({ logger: false });
    registerCitationRoutes(app, service as never);
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/citations/verify?cwd=/not/a/workspace", payload: { text: "x" } });
    expect(response.statusCode).toBe(403);
  });
});
