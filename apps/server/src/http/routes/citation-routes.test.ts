import Fastify from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCitationRoutes } from "./citation-routes.js";
import type { CitationEvidence, VerifyCitationsResult } from "../../runtime/citations/citation-verify-service.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const workspaces: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
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
  schema: 2, kind: "doi", id, status: "found", title: `Paper ${id}`, authors: ["A. Author"], journal: "Nature", year: "2024",
  abstract: "An abstract.", oa_url: null, retraction: "clear", retraction_note: null, retraction_url: null,
  checked_providers: ["crossref"], error: null, record_version: null, status_note: null, verified_at: new Date().toISOString(),
});

const view = (id: string) => ({ ...evidence(id), requested_id: id, requested_version: null, version: "not_applicable" as const, bibliographic: "not_compared" as const, bibliographic_note: null, cached: false });

function fakeService() {
  return {
    verify: vi.fn(async (): Promise<VerifyCitationsResult> => ({
      text_sha256: "abc",
      total: 1,
      processed: 1,
      unprocessed: [],
      citations: [view("10.1/x")],
    })),
    lookup: vi.fn(async () => [{ ...view("10.1/x"), cached: true }]),
    lookupText: vi.fn(async (): Promise<VerifyCitationsResult> => ({
      text_sha256: "abc",
      total: 1,
      processed: 0,
      unprocessed: [],
      citations: [{ ...view("10.1/x"), status: "unchecked", verified_at: "" }],
    })),
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
    expect(service.verify).toHaveBeenCalledWith(canonicalCwd, { text: "Cites 10.1/x here.", refresh: false });
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

  it("passes a manual refresh through to the service", async () => {
    const cwd = await makeWorkspace();
    const service = fakeService();
    const app = Fastify({ logger: false });
    registerCitationRoutes(app, service as never);
    apps.push(app);

    await app.inject({
      method: "POST",
      url: `/api/citations/verify?cwd=${encodeURIComponent(cwd)}`,
      payload: { text: "Cites 10.1/x here.", refresh: true },
    });
    const canonicalCwd = await validateWorkspaceCwd(cwd);
    expect(service.verify).toHaveBeenCalledWith(canonicalCwd, { text: "Cites 10.1/x here.", refresh: true });
  });

  it("answers an agent request from the snapshot while automatic verification is off", async () => {
    const cwd = await makeWorkspace();
    const home = await mkdtemp(join(tmpdir(), "pi-citation-route-home-")); workspaces.push(home);
    vi.stubEnv("PI_SCIENCE_HOME", home);
    await writeFile(join(home, "config.json"), JSON.stringify({ citation_auto_verify: false }));
    const service = fakeService();
    const app = Fastify({ logger: false });
    registerCitationRoutes(app, service as never);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/citations/verify?cwd=${encodeURIComponent(cwd)}`,
      payload: { text: "Cites 10.1/x here.", trigger: "agent", refresh: true },
    });
    expect(response.statusCode).toBe(200);
    expect(service.lookupText).toHaveBeenCalledOnce();
    expect(service.verify).not.toHaveBeenCalled();
  });

  it("queries providers for an agent request once the switch is on", async () => {
    const cwd = await makeWorkspace();
    const home = await mkdtemp(join(tmpdir(), "pi-citation-route-home-")); workspaces.push(home);
    vi.stubEnv("PI_SCIENCE_HOME", home);
    await writeFile(join(home, "config.json"), JSON.stringify({ citation_auto_verify: true }));
    const service = fakeService();
    const app = Fastify({ logger: false });
    registerCitationRoutes(app, service as never);
    apps.push(app);

    await app.inject({
      method: "POST",
      url: `/api/citations/verify?cwd=${encodeURIComponent(cwd)}`,
      payload: { text: "Cites 10.1/x here.", trigger: "agent" },
    });
    expect(service.verify).toHaveBeenCalledOnce();
    expect(service.lookupText).not.toHaveBeenCalled();
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

  it("answers the source chips from the snapshot without a provider request", async () => {
    const cwd = await makeWorkspace();
    const service = fakeService();
    const app = Fastify({ logger: false });
    registerCitationRoutes(app, service as never);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/citations/snapshot?cwd=${encodeURIComponent(cwd)}`,
      payload: { text: "Cites 10.1/x here." },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ citations: [{ id: "10.1/x", status: "unchecked" }] });
    expect(service.lookupText).toHaveBeenCalledOnce();
    expect(service.verify).not.toHaveBeenCalled();

    const empty = await app.inject({ method: "POST", url: `/api/citations/snapshot?cwd=${encodeURIComponent(cwd)}`, payload: { text: " " } });
    expect(empty.statusCode).toBe(400);
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
