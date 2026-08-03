import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerLiteratureRoutes } from "./literature-routes.js";
import { resetThrottle } from "../../literature/providers.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

const UNIPROT_JSON = JSON.stringify({
  results: [
    {
      primaryAccession: "P12345",
      uniProtkbId: "EXMP_HUMAN",
      proteinDescription: { recommendedName: { fullName: { value: "Example protein" } } },
      organism: { scientificName: "Homo sapiens" },
    },
  ],
});

let auditDir = "";

beforeEach(() => {
  resetThrottle();
  // Isolate egress audit writes: never touch the real ~/.pi-science config root.
  auditDir = mkdtempSync(join(tmpdir(), "pi-lit-routes-audit-"));
  process.env.PI_SCIENCE_HOME = auditDir;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(UNIPROT_JSON, { status: 200, headers: { "content-type": "application/json" } })));
});

afterEach(() => {
  delete process.env.PI_SCIENCE_HOME;
  if (auditDir) rmSync(auditDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("literature routes", () => {
  it("rejects a missing or invalid query", async () => {
    const app = Fastify();
    registerLiteratureRoutes(app);
    const missing = await app.inject({ method: "POST", url: "/api/literature/search", payload: {} });
    expect(missing.statusCode).toBe(400);
    const blank = await app.inject({ method: "POST", url: "/api/literature/search", payload: { query: "   " } });
    expect(blank.statusCode).toBe(400);
  });

  it("rejects unknown providers", async () => {
    const app = Fastify();
    registerLiteratureRoutes(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/literature/search",
      payload: { query: "perovskite", providers: ["pubmed", "not-a-provider"] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("providers must be a non-empty subset");
  });

  it("rejects an empty providers array instead of silently meaning all providers", async () => {
    const app = Fastify();
    registerLiteratureRoutes(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/literature/search",
      payload: { query: "perovskite", providers: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("providers must be a non-empty subset");
  });

  it("returns a blocked outcome for sensitive queries", async () => {
    const app = Fastify();
    registerLiteratureRoutes(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/literature/search",
      payload: { query: "sequence ACGTACGTACGTACGTACGT found in sample" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.blocked).toBe(true);
    expect(body.categories).toContain("dna-sequence");
  });

  it("returns provider results for benign queries", async () => {
    const app = Fastify();
    registerLiteratureRoutes(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/literature/search",
      payload: { query: "perovskite", providers: ["uniprot"] },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.blocked).toBe(false);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.provider).toBe("uniprot");
    expect(body.results[0]?.records[0]?.id).toBe("P12345");
  });

  it("issues an approval token that unblocks the exact sensitive query", async () => {
    const app = Fastify();
    registerLiteratureRoutes(app);
    const query = "sequence ACGTACGTACGTACGTACGT found in sample";
    const approval = await app.inject({ method: "POST", url: "/api/literature/approve", payload: { query, categories: ["dna-sequence"] } });
    expect(approval.statusCode).toBe(200);
    const { approvedToken, expiresAt } = approval.json();
    expect(approvedToken).toMatch(/^[0-9a-f]{32}$/);
    expect(expiresAt).toBeTruthy();

    const search = await app.inject({
      method: "POST",
      url: "/api/literature/search",
      payload: { query, providers: ["uniprot"], approvedToken },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().blocked).toBe(false);
  });

  it("rejects approval requests with invalid categories", async () => {
    const app = Fastify();
    registerLiteratureRoutes(app);
    const response = await app.inject({ method: "POST", url: "/api/literature/approve", payload: { query: "x", categories: ["not-a-category"] } });
    expect(response.statusCode).toBe(400);
    const empty = await app.inject({ method: "POST", url: "/api/literature/approve", payload: { query: "x", categories: [] } });
    expect(empty.statusCode).toBe(400);
  });
});
