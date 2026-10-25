import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { citationVerifyService, extractCitations, type CitationDeps } from "./citation-verify-service.js";

const workspaces: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-citations-"));
  workspaces.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  return cwd;
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

describe("extractCitations", () => {
  it("extracts and dedupes DOI and arXiv ids in first-seen order", () => {
    const text = "Prior work (arXiv:2401.12345; also 10.1038/s41586-025-10072-4) and again 10.1038/s41586-025-10072-4. See arXiv:2401.12345v2 too.";
    expect(extractCitations(text)).toEqual([
      { kind: "arxiv", id: "2401.12345" },
      { kind: "doi", id: "10.1038/s41586-025-10072-4" },
    ]);
  });

  it("keeps the rule-compatible with the frontend: trailing punctuation stripped", () => {
    expect(extractCitations("see 10.1234/abc.def.")).toEqual([{ kind: "doi", id: "10.1234/abc.def" }]);
  });
});

describe("citationVerifyService.verify", () => {
  it("resolves DOIs through Crossref and persists evidence snapshots", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("https://api.crossref.org/works/")) {
          return jsonResponse({
            status: "ok",
            message: {
              title: ["Attention Is All You Need"],
              author: [{ given: "Ashish", family: "Vaswani" }],
              "container-title": ["Nature"],
              issued: { "date-parts": [[2017]] },
              abstract: "<p>The Transformer architecture.</p>",
            },
          });
        }
        return jsonResponse({}, 404);
      }),
    };

    const result = await citationVerifyService.verify(cwd, { text: "The Transformer (10.1038/x) changed everything." }, deps);
    // The DOI above is fake for the test; force a found path with the real parse.
    expect(result.citations).toHaveLength(1);
    const cache = await readFile(join(cwd, ".pi-science", "citations.jsonl"), "utf8");
    expect(cache).toContain("10.1038/x");
    expect(result.text_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks citations as found with full metadata when Crossref resolves", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (new URL(url).host === "api.crossref.org") {
          return jsonResponse({
            status: "ok",
            message: {
              title: ["Attention Is All You Need"],
              author: [{ given: "Ashish", family: "Vaswani" }],
              "container-title": ["Nature"],
              issued: { "date-parts": [[2017]] },
              "update-to": [{ type: "retraction", label: "Retraction: Attention Is All You Need" }],
            },
          });
        }
        return jsonResponse({}, 404);
      }),
    };
    const result = await citationVerifyService.verify(cwd, { text: "Cites 10.1038/transformer." }, deps);
    expect(result.citations[0]).toMatchObject({
      kind: "doi", id: "10.1038/transformer", status: "found",
      title: "Attention Is All You Need", journal: "Nature", year: "2017",
      retracted: true,
    });
    expect(result.citations[0]!.cached).toBe(false);
  });

  it("reuses fresh cache entries without contacting providers again", async () => {
    const cwd = await makeWorkspace();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (new URL(url).host === "api.crossref.org") {
        return jsonResponse({ status: "ok", message: { title: ["One Paper"], author: [], issued: { "date-parts": [[2020]] } } });
      }
      return jsonResponse({}, 404);
    });
    const deps: CitationDeps = { fetch: fetchMock as unknown as typeof fetch };
    await citationVerifyService.verify(cwd, { text: "10.1038/one" }, deps);
    const again = await citationVerifyService.verify(cwd, { text: "10.1038/one again" }, deps);
    expect(again.citations[0]).toMatchObject({ id: "10.1038/one", cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records not_found evidence when the DOI does not resolve", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = { fetch: vi.fn(async () => jsonResponse({ status: "resource not found" }, 404)) };
    const result = await citationVerifyService.verify(cwd, { text: "Ghost cite 10.9999/nothing." }, deps);
    expect(result.citations[0]).toMatchObject({ status: "not_found", retracted: false });
  });

  it("degrades gracefully when a provider request fails", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = { fetch: vi.fn(async () => { throw new Error("network down"); }) };
    const result = await citationVerifyService.verify(cwd, { text: "10.1038/failing" }, deps);
    expect(result.citations[0]).toMatchObject({ status: "not_found" });
    expect(result.citations[0]!.retraction_note).toContain("verification request failed");
  });

  it("resolves arXiv ids through the arXiv API", async () => {
    const cwd = await makeWorkspace();
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2401.12345v1</id><published>2024-01-22T00:00:00Z</published><title>Paper Title</title><summary>A summary.</summary><author><name>Ada Lovelace</name></author></entry></feed>`;
    const deps: CitationDeps = { fetch: vi.fn(async () => ({ ok: true, status: 200, text: async () => xml } as unknown as Response)) };
    const result = await citationVerifyService.verify(cwd, { text: "As shown in arXiv:2401.12345." }, deps);
    expect(result.citations[0]).toMatchObject({
      kind: "arxiv", id: "2401.12345", status: "found", title: "Paper Title", year: "2024",
      oa_url: "https://arxiv.org/abs/2401.12345",
    });
  });
});

describe("citationVerifyService.lookup", () => {
  it("returns cached snapshots by composite id without network access", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      fetch: vi.fn(async (input: string | URL | Request) => {
        if (new URL(String(input)).host === "api.crossref.org") return jsonResponse({ status: "ok", message: { title: ["Cached Paper"], author: [], issued: { "date-parts": [[2021]] } } });
        return jsonResponse({}, 404);
      }),
    };
    await citationVerifyService.verify(cwd, { text: "10.1038/cached" }, deps);
    const hits = await citationVerifyService.lookup(cwd, ["doi:10.1038/cached", "doi:10.1038/missing", "bogus:x"]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "10.1038/cached", title: "Cached Paper" });
  });
});
