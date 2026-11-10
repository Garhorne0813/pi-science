import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  citationVerifyService,
  extractCitations,
  MAX_CITATIONS_PER_CALL,
  type CitationDeps,
} from "./citation-verify-service.js";

const workspaces: string[] = [];
const FAST: CitationDeps["minimumInterval"] = {
  "api.crossref.org": 0,
  "api.unpaywall.org": 0,
  "export.arxiv.org": 0,
  "doi.org": 0,
};

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

function xmlResponse(xml: string): Response {
  return { ok: true, status: 200, text: async () => xml } as unknown as Response;
}

/** Crossref record shape as returned for a live DOI; the retraction fixtures
 *  below use the real relation layout observed on api.crossref.org. */
const crossrefRecord = (message: Record<string, unknown>) =>
  jsonResponse({ status: "ok", message });

function crossrefFetch(
  message: Record<string, unknown>,
  extra: (url: URL) => Response | null = () => null,
) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const handled = extra(url);
    if (handled) return handled;
    if (url.host === "api.crossref.org") return crossrefRecord(message);
    return jsonResponse({ status: "resource not found" }, 404);
  });
}

const arxivFeed = ({
  id,
  title,
  summary,
  published,
}: {
  id: string;
  title: string;
  summary: string;
  published: string;
}): string =>
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/${id}</id><published>${published}T00:00:00Z</published><title>${title}</title><summary>${summary}</summary><author><name>Ada Lovelace</name></author></entry></feed>`;

async function cacheRows(cwd: string): Promise<string> {
  return readFile(join(cwd, ".pi-science", "citations.jsonl"), "utf8").catch(() => "");
}

describe("extractCitations", () => {
  it("keeps one reference per source and keeps two cited arXiv versions apart", () => {
    const text = "See arXiv:2401.12345v1, then arXiv:2401.12345v2, and arXiv:1706.03762.";
    expect(extractCitations(text)).toEqual([
      { kind: "arxiv", id: "2401.12345", requested_id: "2401.12345v1", requested_version: "1" },
      { kind: "arxiv", id: "2401.12345", requested_id: "2401.12345v2", requested_version: "2" },
      { kind: "arxiv", id: "1706.03762", requested_id: "1706.03762", requested_version: null },
    ]);
  });

  it("dedupes DOIs case-insensitively and keeps first-seen order across kinds", () => {
    const text = "10.1038/ABC then arXiv:2401.12345 then 10.1038/abc.";
    expect(extractCitations(text)).toEqual([
      { kind: "doi", id: "10.1038/abc", requested_id: "10.1038/abc", requested_version: null },
      { kind: "arxiv", id: "2401.12345", requested_id: "2401.12345", requested_version: null },
    ]);
  });

  it("strips trailing punctuation but keeps dots inside a DOI suffix", () => {
    expect(extractCitations("see 10.1234/abc.def.")).toEqual([
      {
        kind: "doi",
        id: "10.1234/abc.def",
        requested_id: "10.1234/abc.def",
        requested_version: null,
      },
    ]);
  });

  it("terminates DOI matches at CJK text and fullwidth punctuation", () => {
    const text = "AlphaFold 蛋白结构预测方法见 10.1038/s41586-020-2649-2，另见 arXiv:1706.03762。";
    expect(extractCitations(text)).toEqual([
      {
        kind: "doi",
        id: "10.1038/s41586-020-2649-2",
        requested_id: "10.1038/s41586-020-2649-2",
        requested_version: null,
      },
      { kind: "arxiv", id: "1706.03762", requested_id: "1706.03762", requested_version: null },
    ]);
  });

  it("reads its own numbered marker back as punctuation, not as part of the id", () => {
    const text = "The gain holds on QA (10.1000/alpha)[1] and on retrieval (10.1000/beta)[2].";
    expect(extractCitations(text)).toEqual([
      { kind: "doi", id: "10.1000/alpha", requested_id: "10.1000/alpha", requested_version: null },
      { kind: "doi", id: "10.1000/beta", requested_id: "10.1000/beta", requested_version: null },
    ]);
  });

  it("skips an identifier the body only shows inside code or math", () => {
    const text = [
      "Prose cites 10.1000/real.",
      "",
      "```",
      "10.1000/fenced",
      "```",
      "",
      "Inline `10.1000/inline` and math $10.1000/math$.",
    ].join("\n");
    expect(extractCitations(text)).toEqual([
      { kind: "doi", id: "10.1000/real", requested_id: "10.1000/real", requested_version: null },
    ]);
  });
});

describe("citationVerifyService.verify", () => {
  it("reports source metadata without claiming the claim is supported", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: crossrefFetch({
        title: ["Attention Is All You Need"],
        author: [{ given: "Ashish", family: "Vaswani" }],
        "container-title": ["Nature"],
        volume: "30",
        issue: "3",
        page: "1125-1136",
        issued: { "date-parts": [[2017]] },
        abstract: "<p>The Transformer architecture.</p>",
      }) as unknown as typeof fetch,
    };
    const result = await citationVerifyService.verify(
      cwd,
      { text: "The Transformer (10.1038/x) changed everything." },
      deps,
    );
    expect(result.citations[0]).toMatchObject({
      kind: "doi",
      id: "10.1038/x",
      status: "found",
      title: "Attention Is All You Need",
      journal: "Nature",
      year: "2017",
      volume: "30",
      issue: "3",
      pages: "1125-1136",
      retraction: "clear",
      checked_providers: ["crossref"],
      error: null,
      version: "not_applicable",
      cached: false,
    });
    expect(await cacheRows(cwd)).toContain("10.1038/x");
  });

  it("reads a snapshot row written before the numbering fields as nulls and fills them on refresh", async () => {
    const cwd = await makeWorkspace();
    // A row from before volume/issue/pages existed: it carries none of them.
    const row = {
      schema: 2,
      kind: "doi",
      id: "10.1038/old-row",
      status: "found",
      title: "Old Row Paper",
      authors: [],
      journal: "Nature",
      year: "2019",
      abstract: null,
      oa_url: null,
      retraction: "clear",
      retraction_note: null,
      retraction_url: null,
      checked_providers: ["crossref"],
      record_version: null,
      status_note: null,
      verified_at: new Date().toISOString(),
    };
    await writeFile(join(cwd, ".pi-science", "citations.jsonl"), `${JSON.stringify(row)}\n`);
    const [hit] = await citationVerifyService.lookup(cwd, ["doi:10.1038/old-row"]);
    expect(hit).toMatchObject({
      title: "Old Row Paper",
      volume: null,
      issue: null,
      pages: null,
      cached: true,
    });

    const fetchMock = crossrefFetch({
      title: ["Old Row Paper"],
      author: [],
      issued: { "date-parts": [[2019]] },
      volume: "12",
      issue: "4",
      page: "77-88",
    }) as unknown as typeof fetch;
    const refreshed = await citationVerifyService.verify(
      cwd,
      { text: "10.1038/old-row", refresh: true },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(refreshed.citations[0]).toMatchObject({
      volume: "12",
      issue: "4",
      pages: "77-88",
      cached: false,
    });
  });

  it("verifies only the sources a follow-up round names and replays a snapshot instead of asking again", async () => {
    const cwd = await makeWorkspace();
    const fetchMock = crossrefFetch({
      title: ["Named Paper"],
      author: [],
      issued: { "date-parts": [[2020]] },
    }) as unknown as typeof fetch;
    const text = "10.1038/first and 10.1038/second";
    const refs = extractCitations(text);
    const first = await citationVerifyService.verify(
      cwd,
      { text },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(first.citations.map((citation) => citation.id)).toEqual([
      "10.1038/first",
      "10.1038/second",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const followUp = await citationVerifyService.verify(
      cwd,
      { text, ids: [refs[1]!] },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(followUp).toMatchObject({ total: 1, processed: 1, unprocessed: [] });
    expect(followUp.citations[0]).toMatchObject({ id: "10.1038/second", cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses a fresh snapshot without contacting providers again", async () => {
    const cwd = await makeWorkspace();
    const fetchMock = crossrefFetch({
      title: ["One Paper"],
      author: [],
      issued: { "date-parts": [[2020]] },
    }) as unknown as typeof fetch;
    await citationVerifyService.verify(
      cwd,
      { text: "10.1038/one" },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    const again = await citationVerifyService.verify(
      cwd,
      { text: "10.1038/one again" },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(again.citations[0]).toMatchObject({ id: "10.1038/one", cached: true, status: "found" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-queries providers when a manual retry asks for a refresh", async () => {
    const cwd = await makeWorkspace();
    const fetchMock = crossrefFetch({
      title: ["One Paper"],
      author: [],
      issued: { "date-parts": [[2020]] },
    }) as unknown as typeof fetch;
    await citationVerifyService.verify(
      cwd,
      { text: "10.1038/one" },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    const refreshed = await citationVerifyService.verify(
      cwd,
      { text: "10.1038/one", refresh: true },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(refreshed.citations[0]).toMatchObject({ id: "10.1038/one", cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("names the source that answered when a DOI is not in Crossref", async () => {
    const cwd = await makeWorkspace();
    // Live shape of doi.org/doiRA/<doi> for an identifier no agency registered.
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.host === "doi.org")
          return jsonResponse([{ DOI: "10.9999/nothing", status: "DOI does not exist" }]);
        return jsonResponse({ status: "resource not found" }, 404);
      }) as unknown as typeof fetch,
    };
    const result = await citationVerifyService.verify(
      cwd,
      { text: "Ghost cite 10.9999/nothing." },
      deps,
    );
    // Crossref does not register every DOI, so the state says which source missed
    // and whether any registration agency claims the identifier.
    expect(result.citations[0]).toMatchObject({
      status: "not_found",
      checked_providers: ["crossref", "doi.org"],
      retraction: "unknown",
      title: null,
    });
    expect(result.citations[0]!.status_note).toBe("No DOI registration agency claims this DOI");
  });

  it("names the registration agency that holds a DOI Crossref does not", async () => {
    // Live shape for 10.5061/dryad.8515: Crossref has no record, doi.org names DataCite.
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.host === "doi.org")
          return jsonResponse([{ DOI: "10.5061/dryad.8515", RA: "DataCite" }]);
        return jsonResponse({ status: "resource not found" }, 404);
      }) as unknown as typeof fetch,
    };
    const first = await citationVerifyService.verify(cwd, { text: "10.5061/dryad.8515" }, deps);
    expect(first.citations[0]).toMatchObject({
      status: "not_found",
      checked_providers: ["crossref", "doi.org (DataCite)"],
    });
    expect(first.citations[0]!.status_note).toContain("DataCite registers it");
    expect(first.citations[0]!.status_note).toContain("not read yet");

    const offline: CitationDeps = {
      minimumInterval: FAST,
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    };
    const cached = await citationVerifyService.verify(cwd, { text: "10.5061/dryad.8515" }, offline);
    expect(cached.citations[0]).toMatchObject({
      cached: true,
      checked_providers: ["crossref", "doi.org (DataCite)"],
    });
    expect(cached.citations[0]!.status_note).toContain("DataCite registers it");
  });

  it("keeps a failed agency check from claiming the DOI does not exist", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: vi.fn(async (input: string | URL | Request) => {
        if (new URL(String(input)).host === "doi.org") throw new Error("doi.org unreachable");
        return jsonResponse({ status: "resource not found" }, 404);
      }) as unknown as typeof fetch,
    };
    const result = await citationVerifyService.verify(cwd, { text: "10.1038/unchecked" }, deps);
    expect(result.citations[0]).toMatchObject({
      status: "not_found",
      checked_providers: ["crossref"],
    });
    expect(result.citations[0]!.status_note).toBe(
      "Crossref does not hold this DOI; the registration agency could not be checked",
    );
  });

  it("reports a rate limit as a failed lookup and does not cache it as a missing paper", async () => {
    const cwd = await makeWorkspace();
    const limited: CitationDeps = {
      minimumInterval: FAST,
      fetch: vi.fn(async () => jsonResponse({}, 429)) as unknown as typeof fetch,
    };
    const failed = await citationVerifyService.verify(cwd, { text: "10.1038/limited" }, limited);
    expect(failed.citations[0]).toMatchObject({ status: "error", retraction: "unknown" });
    expect(failed.citations[0]!.error).toContain("HTTP 429");
    expect(await cacheRows(cwd)).not.toContain("10.1038/limited");

    const recovered: CitationDeps = {
      minimumInterval: FAST,
      fetch: crossrefFetch({
        title: ["Recovered Paper"],
        author: [],
        issued: { "date-parts": [[2021]] },
      }) as unknown as typeof fetch,
    };
    const retried = await citationVerifyService.verify(cwd, { text: "10.1038/limited" }, recovered);
    expect(retried.citations[0]).toMatchObject({
      status: "found",
      title: "Recovered Paper",
      cached: false,
    });
  });

  it("reads a retraction notice reported on the original record", async () => {
    // Live shape of 10.1016/s0140-6736(97)11096-0: the notice lives in updated-by.
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: crossrefFetch({
        title: ["RETRACTED: Ileal-lymphoid-nodular hyperplasia"],
        author: [],
        issued: { "date-parts": [[1998]] },
        "updated-by": [
          {
            DOI: "10.1016/S0140-6736(10)60175-4",
            type: "retraction",
            label: "Retraction",
            source: "retraction-watch",
            updated: { "date-parts": [[2010, 2, 6]] },
          },
        ],
      }) as unknown as typeof fetch,
    };
    const result = await citationVerifyService.verify(
      cwd,
      { text: "10.1016/s0140-6736(97)11096-0" },
      deps,
    );
    expect(result.citations[0]).toMatchObject({
      status: "found",
      retraction: "retracted",
      retraction_url: "https://doi.org/10.1016/S0140-6736(10)60175-4",
    });
    expect(result.citations[0]!.retraction_note).toContain("Retraction");
  });

  it("reads a retraction relation reported on the notice record", async () => {
    // Live shape of 10.1016/s0140-6736(10)60175-4: the notice points back through update-to.
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: crossrefFetch({
        title: ["Retraction—Ileal-lymphoid-nodular hyperplasia"],
        author: [],
        issued: { "date-parts": [[2010]] },
        "update-to": [
          {
            DOI: "10.1016/s0140-6736(97)11096-0",
            type: "retraction",
            label: "Retraction",
            source: "retraction-watch",
          },
        ],
      }) as unknown as typeof fetch,
    };
    const result = await citationVerifyService.verify(
      cwd,
      { text: "10.1016/s0140-6736(10)60175-4" },
      deps,
    );
    expect(result.citations[0]).toMatchObject({
      retraction: "retracted",
      retraction_url: "https://doi.org/10.1016/s0140-6736(97)11096-0",
    });
  });

  it("keeps the retraction state clear when no notice is reported", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: crossrefFetch({
        title: ["Clean Paper"],
        author: [],
        issued: { "date-parts": [[2019]] },
        "updated-by": [],
      }) as unknown as typeof fetch,
    };
    const result = await citationVerifyService.verify(cwd, { text: "10.1038/clean" }, deps);
    expect(result.citations[0]).toMatchObject({
      status: "found",
      retraction: "clear",
      retraction_note: null,
    });
  });

  it("confirms the cited arXiv version when the feed serves it", async () => {
    const cwd = await makeWorkspace();
    const xml = arxivFeed({
      id: "2401.12345v1",
      title: "Paper Title",
      summary: "A summary.",
      published: "2024-01-22",
    });
    const fetchMock = vi.fn(async () => xmlResponse(xml)) as unknown as typeof fetch;
    const result = await citationVerifyService.verify(
      cwd,
      { text: "As shown in arXiv:2401.12345v1." },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(result.citations[0]).toMatchObject({
      kind: "arxiv",
      id: "2401.12345",
      requested_id: "2401.12345v1",
      requested_version: "1",
      status: "found",
      title: "Paper Title",
      abstract: "A summary.",
      oa_url: "https://arxiv.org/abs/2401.12345",
      volume: null,
      issue: null,
      pages: null,
      version: "confirmed",
      record_version: "1",
    });
    const requested = String(
      new URL(
        String((fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]),
      ).searchParams.get("id_list"),
    );
    expect(requested).toBe("2401.12345");
  });

  it("marks a version mismatch without passing the current abstract off as the cited one", async () => {
    const cwd = await makeWorkspace();
    const xml = arxivFeed({
      id: "2401.12345v1",
      title: "Paper Title",
      summary: "Summary of version one.",
      published: "2024-01-22",
    });
    const fetchMock = vi.fn(async () => xmlResponse(xml)) as unknown as typeof fetch;
    const result = await citationVerifyService.verify(
      cwd,
      { text: "As shown in arXiv:2401.12345v2." },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(result.citations[0]).toMatchObject({
      status: "found",
      version: "unconfirmed",
      record_version: "1",
      abstract: null,
    });
  });

  it("reports both cited versions of one paper from a single query", async () => {
    const cwd = await makeWorkspace();
    const xml = arxivFeed({
      id: "2401.12345v2",
      title: "Paper Title",
      summary: "Summary of version two.",
      published: "2024-01-22",
    });
    const fetchMock = vi.fn(async () => xmlResponse(xml)) as unknown as typeof fetch;
    const result = await citationVerifyService.verify(
      cwd,
      { text: "Earlier arXiv:2401.12345v1, later arXiv:2401.12345v2." },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(
      result.citations.map((citation) => [
        citation.requested_version,
        citation.version,
        citation.abstract,
      ]),
    ).toEqual([
      ["1", "unconfirmed", null],
      ["2", "confirmed", "Summary of version two."],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the record abstract on the snapshot when the older version is cited first", async () => {
    const cwd = await makeWorkspace();
    const xml = arxivFeed({
      id: "2401.12345v2",
      title: "Paper Title",
      summary: "Summary of version two.",
      published: "2024-01-22",
    });
    const fetchMock = vi.fn(async () => xmlResponse(xml)) as unknown as typeof fetch;
    const cited = await citationVerifyService.verify(
      cwd,
      { text: "As shown in arXiv:2401.12345v1." },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(cited.citations[0]).toMatchObject({
      requested_version: "1",
      record_version: "2",
      version: "unconfirmed",
      abstract: null,
    });
    // One source, one snapshot: hiding the abstract from this citation must not
    // drop it from the cache the next citation of the current version reads.
    expect(await cacheRows(cwd)).toContain("Summary of version two.");

    const current = await citationVerifyService.verify(
      cwd,
      { text: "As shown in arXiv:2401.12345v2." },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(current.citations[0]).toMatchObject({
      requested_version: "2",
      version: "confirmed",
      abstract: "Summary of version two.",
      cached: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a later citation of another version from reading the cached abstract", async () => {
    const cwd = await makeWorkspace();
    const xml = arxivFeed({
      id: "2401.12345v2",
      title: "Paper Title",
      summary: "Summary of version two.",
      published: "2024-01-22",
    });
    const fetchMock = vi.fn(async () => xmlResponse(xml)) as unknown as typeof fetch;
    await citationVerifyService.verify(
      cwd,
      { text: "As shown in arXiv:2401.12345v2." },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    const older = await citationVerifyService.verify(
      cwd,
      { text: "As shown in arXiv:2401.12345v1." },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(older.citations[0]).toMatchObject({
      requested_version: "1",
      version: "unconfirmed",
      abstract: null,
      cached: true,
    });
    // The id lookup reads the same snapshot and must hide it the same way.
    const [lookedUp] = await citationVerifyService.lookup(cwd, ["arxiv:2401.12345v1"]);
    expect(lookedUp).toMatchObject({ version: "unconfirmed", abstract: null });
  });

  it("labels an unversioned arXiv citation as version unconfirmed and keeps the current abstract", async () => {
    const cwd = await makeWorkspace();
    const xml = arxivFeed({
      id: "2401.12345v2",
      title: "Paper Title",
      summary: "Summary of version two.",
      published: "2024-01-22",
    });
    const fetchMock = vi.fn(async () => xmlResponse(xml)) as unknown as typeof fetch;
    const result = await citationVerifyService.verify(
      cwd,
      { text: "As shown in arXiv:2401.12345." },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(result.citations[0]).toMatchObject({
      requested_version: null,
      version: "unconfirmed",
      record_version: "2",
      abstract: "Summary of version two.",
    });
  });

  it("reports the arXiv retraction state as unknown instead of claiming it is clean", async () => {
    const cwd = await makeWorkspace();
    const xml = arxivFeed({
      id: "2401.12345v1",
      title: "Paper Title",
      summary: "A summary.",
      published: "2024-01-22",
    });
    const fetchMock = vi.fn(async () => xmlResponse(xml)) as unknown as typeof fetch;
    const result = await citationVerifyService.verify(
      cwd,
      { text: "arXiv:2401.12345" },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(result.citations[0]).toMatchObject({
      retraction: "unknown",
      retraction_note: "arXiv does not publish retraction metadata",
    });
  });

  it("treats an arXiv rate-limit feed as a failed lookup instead of a missing paper", async () => {
    // Live shape: HTTP 200 with an entry filed under /api/errors. Caching this
    // as not_found would report a real paper as absent for a week.
    const cwd = await makeWorkspace();
    const limited = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/api/errors#too_many_requests</id><title>API rate limit exceeded</title><summary>Retry after a delay.</summary></entry></feed>`;
    const fetchMock = vi.fn(async () => xmlResponse(limited)) as unknown as typeof fetch;
    const failed = await citationVerifyService.verify(
      cwd,
      { text: "arXiv:2401.12345" },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(failed.citations[0]).toMatchObject({ status: "error", title: null });
    expect(failed.citations[0]!.error).toContain("API error feed");
    expect(failed.citations[0]!.error).toContain("API rate limit exceeded");
    expect(await cacheRows(cwd)).not.toContain("2401.12345");

    const recovered = vi.fn(async () =>
      xmlResponse(
        arxivFeed({
          id: "2401.12345v1",
          title: "Paper Title",
          summary: "A summary.",
          published: "2024-01-22",
        }),
      ),
    ) as unknown as typeof fetch;
    const retried = await citationVerifyService.verify(
      cwd,
      { text: "arXiv:2401.12345" },
      { fetch: recovered, minimumInterval: FAST },
    );
    expect(retried.citations[0]).toMatchObject({
      status: "found",
      title: "Paper Title",
      cached: false,
    });
  });

  it("reads an empty arXiv feed as a paper the source does not hold", async () => {
    const cwd = await makeWorkspace();
    const fetchMock = vi.fn(async () =>
      xmlResponse(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`),
    ) as unknown as typeof fetch;
    const result = await citationVerifyService.verify(
      cwd,
      { text: "arXiv:2401.99999" },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(result.citations[0]).toMatchObject({
      status: "not_found",
      checked_providers: ["arxiv"],
    });
    expect(await cacheRows(cwd)).toContain("2401.99999");
  });

  it("keeps one failed lookup from failing the whole batch", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: vi.fn(async (input: string | URL | Request) => {
        if (new URL(String(input)).host === "api.crossref.org")
          return crossrefRecord({
            title: ["Known Paper"],
            author: [],
            issued: { "date-parts": [[2020]] },
          });
        throw new Error("network down");
      }) as unknown as typeof fetch,
    };
    const result = await citationVerifyService.verify(
      cwd,
      { text: "10.1038/known and arXiv:2401.12345" },
      deps,
    );
    expect(result.citations[0]).toMatchObject({ id: "10.1038/known", status: "found" });
    expect(result.citations[1]).toMatchObject({ kind: "arxiv", status: "error" });
    expect(result.citations[1]!.error).toContain("network down");
  });

  it("reports the citations it did not process instead of truncating silently", async () => {
    const cwd = await makeWorkspace();
    const text = Array.from(
      { length: MAX_CITATIONS_PER_CALL + 2 },
      (_, index) => `10.1038/paper-${index}`,
    ).join(" ");
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: crossrefFetch({
        title: ["Batch Paper"],
        author: [],
        issued: { "date-parts": [[2020]] },
      }) as unknown as typeof fetch,
    };
    const result = await citationVerifyService.verify(cwd, { text }, deps);
    expect(result.total).toBe(MAX_CITATIONS_PER_CALL + 2);
    expect(result.processed).toBe(MAX_CITATIONS_PER_CALL);
    expect(result.citations).toHaveLength(MAX_CITATIONS_PER_CALL);
    expect(result.unprocessed.map((ref) => ref.id)).toEqual([
      "10.1038/paper-30",
      "10.1038/paper-31",
    ]);
  });
});

describe("bibliographic check", () => {
  const transformerRecord = {
    title: ["Attention Is All You Need"],
    author: [{ given: "Ashish", family: "Vaswani" }],
    issued: { "date-parts": [[2017]] },
  };

  it("flags a reference entry whose title belongs to another paper", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: crossrefFetch(transformerRecord) as unknown as typeof fetch,
    };
    const text =
      "References\n\n1. He, K., Zhang, X. (2016). Deep residual learning for image recognition. CVPR. 10.1038/x";
    const result = await citationVerifyService.verify(cwd, { text }, deps);
    expect(result.citations[0]).toMatchObject({ status: "found", bibliographic: "mismatch" });
    expect(result.citations[0]!.bibliographic_note).toContain("Deep residual learning");
  });

  it("confirms a reference entry that states the record title", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: crossrefFetch(transformerRecord) as unknown as typeof fetch,
    };
    const text =
      "References\n\n[1] Vaswani, A. (2017). Attention is all you need. NeurIPS. 10.1038/x";
    const result = await citationVerifyService.verify(cwd, { text }, deps);
    expect(result.citations[0]).toMatchObject({ bibliographic: "match", bibliographic_note: null });
  });

  it("does not treat prose that only mentions a DOI as a title match or a mismatch", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: crossrefFetch(transformerRecord) as unknown as typeof fetch,
    };
    const result = await citationVerifyService.verify(
      cwd,
      { text: "The Transformer paper (10.1038/x) changed everything in 2017." },
      deps,
    );
    expect(result.citations[0]).toMatchObject({
      status: "found",
      bibliographic: "not_compared",
      bibliographic_note: null,
    });
  });

  it("leaves a non-Latin title uncompared instead of calling it a mismatch", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: crossrefFetch({
        title: ["蛋白质结构预测"],
        author: [],
        issued: { "date-parts": [[2021]] },
      }) as unknown as typeof fetch,
    };
    const text = "1. 张三 (2021). 蛋白质结构预测. 生物学报. 10.1038/x";
    const result = await citationVerifyService.verify(cwd, { text }, deps);
    expect(result.citations[0]).toMatchObject({ kind: "doi", bibliographic: "not_compared" });
  });
});

describe("citationVerifyService.verifyIds", () => {
  it("queries the named source and replays its snapshot without asking again", async () => {
    const cwd = await makeWorkspace();
    const fetchMock = crossrefFetch({
      title: ["Named Paper"],
      author: [],
      issued: { "date-parts": [[2020]] },
    }) as unknown as typeof fetch;
    const first = await citationVerifyService.verifyIds(
      cwd,
      ["doi:10.1038/named"],
      {},
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(first).toMatchObject({ total: 1, processed: 1, unprocessed: [] });
    expect(first.citations[0]).toMatchObject({
      id: "10.1038/named",
      status: "found",
      title: "Named Paper",
      cached: false,
      bibliographic: "not_compared",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The field stays meaningful without answer text: it names the id list.
    expect(first.text_sha256).toBe(createHash("sha256").update("doi:10.1038/named").digest("hex"));

    const replay = await citationVerifyService.verifyIds(
      cwd,
      ["doi:10.1038/named"],
      {},
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(replay.citations[0]).toMatchObject({ id: "10.1038/named", cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-queries a source that already has a fresh snapshot when the check asks for a refresh", async () => {
    const cwd = await makeWorkspace();
    const fetchMock = crossrefFetch({
      title: ["Named Paper"],
      author: [],
      issued: { "date-parts": [[2020]] },
    }) as unknown as typeof fetch;
    await citationVerifyService.verifyIds(
      cwd,
      ["doi:10.1038/named"],
      {},
      { fetch: fetchMock, minimumInterval: FAST },
    );
    const refreshed = await citationVerifyService.verifyIds(
      cwd,
      ["doi:10.1038/named"],
      { refresh: true },
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(refreshed.citations[0]).toMatchObject({ cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a provider failure as an error, caches nothing and re-queries next time", async () => {
    const cwd = await makeWorkspace();
    const limited = vi.fn(async () => jsonResponse({}, 429)) as unknown as typeof fetch;
    const failed = await citationVerifyService.verifyIds(
      cwd,
      ["doi:10.1038/limited"],
      {},
      { fetch: limited, minimumInterval: FAST },
    );
    expect(failed.citations[0]).toMatchObject({ status: "error", title: null });
    expect(failed.citations[0]!.error).toContain("HTTP 429");
    expect(await cacheRows(cwd)).not.toContain("10.1038/limited");

    const recovered = crossrefFetch({
      title: ["Recovered Paper"],
      author: [],
      issued: { "date-parts": [[2021]] },
    }) as unknown as typeof fetch;
    const retried = await citationVerifyService.verifyIds(
      cwd,
      ["doi:10.1038/limited"],
      {},
      { fetch: recovered, minimumInterval: FAST },
    );
    expect(retried.citations[0]).toMatchObject({
      status: "found",
      title: "Recovered Paper",
      cached: false,
    });
    expect(limited).toHaveBeenCalledTimes(1);
  });

  it("shares one query for two spellings of one arXiv id and keeps the version that was asked for", async () => {
    const cwd = await makeWorkspace();
    const xml = arxivFeed({
      id: "2301.01234v2",
      title: "Named Paper",
      summary: "A summary.",
      published: "2023-01-03",
    });
    const fetchMock = vi.fn(async () => xmlResponse(xml)) as unknown as typeof fetch;
    const result = await citationVerifyService.verifyIds(
      cwd,
      ["arxiv:2301.01234v2", "arxiv:2301.01234"],
      {},
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(result.total).toBe(1);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({
      id: "2301.01234",
      requested_version: "2",
      record_version: "2",
      version: "confirmed",
      status: "found",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      String(
        new URL(
          String((fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]),
        ).searchParams.get("id_list"),
      ),
    ).toBe("2301.01234");
  });

  it("drops an unsupported kind without contacting anything", async () => {
    const cwd = await makeWorkspace();
    const fetchMock = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const result = await citationVerifyService.verifyIds(
      cwd,
      ["pmid:12345678", "doi:", "bogus"],
      {},
      { fetch: fetchMock, minimumInterval: FAST },
    );
    expect(result).toMatchObject({ total: 0, processed: 0, citations: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the ids past the batch cap instead of truncating silently", async () => {
    const cwd = await makeWorkspace();
    const ids = Array.from(
      { length: MAX_CITATIONS_PER_CALL + 2 },
      (_, index) => `doi:10.1038/paper-${index}`,
    );
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: crossrefFetch({
        title: ["Batch Paper"],
        author: [],
        issued: { "date-parts": [[2020]] },
      }) as unknown as typeof fetch,
    };
    const result = await citationVerifyService.verifyIds(cwd, ids, {}, deps);
    expect(result.total).toBe(MAX_CITATIONS_PER_CALL + 2);
    expect(result.processed).toBe(MAX_CITATIONS_PER_CALL);
    expect(result.citations).toHaveLength(MAX_CITATIONS_PER_CALL);
    expect(result.unprocessed.map((ref) => ref.id)).toEqual([
      "10.1038/paper-30",
      "10.1038/paper-31",
    ]);
  });
});

describe("citationVerifyService.lookup", () => {
  it("returns the source snapshot for the version that was cited", async () => {
    const cwd = await makeWorkspace();
    const xml = arxivFeed({
      id: "2401.12345v1",
      title: "Cached Paper",
      summary: "A summary.",
      published: "2024-01-22",
    });
    const fetchMock = vi.fn(async () => xmlResponse(xml)) as unknown as typeof fetch;
    await citationVerifyService.verify(
      cwd,
      { text: "arXiv:2401.12345v1" },
      { fetch: fetchMock, minimumInterval: FAST },
    );

    const [confirmed] = await citationVerifyService.lookup(cwd, ["arxiv:2401.12345v1"]);
    expect(confirmed).toMatchObject({
      title: "Cached Paper",
      version: "confirmed",
      record_version: "1",
      cached: true,
    });
    // A different version reads the same source snapshot but must not claim
    // that snapshot describes the cited text.
    const [mismatch] = await citationVerifyService.lookup(cwd, ["arxiv:2401.12345v2"]);
    expect(mismatch).toMatchObject({
      id: "2401.12345",
      requested_version: "2",
      version: "unconfirmed",
    });
    expect(await citationVerifyService.lookup(cwd, ["arxiv:9999.99999", "bogus:x"])).toEqual([]);
  });

  it("returns cached DOI snapshots without network access", async () => {
    const cwd = await makeWorkspace();
    await citationVerifyService.verify(
      cwd,
      { text: "10.1038/cached" },
      {
        minimumInterval: FAST,
        fetch: crossrefFetch({
          title: ["Cached Paper"],
          author: [],
          issued: { "date-parts": [[2021]] },
        }) as unknown as typeof fetch,
      },
    );
    const hits = await citationVerifyService.lookup(cwd, [
      "doi:10.1038/cached",
      "doi:10.1038/missing",
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: "10.1038/cached",
      title: "Cached Paper",
      version: "not_applicable",
      cached: true,
    });
  });
});
