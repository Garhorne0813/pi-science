import { describe, expect, it } from "vitest";
import { arxivSearchInput, crossrefSearchInput, pubmedSearchInput, searchArxiv, searchCrossref, searchPubmed, type SearchDependencies } from "./paper-search.js";

const now = () => new Date("2026-09-06T00:00:00.000Z");

function responses(...values: Array<{ body: string; status?: number; headers?: Record<string, string> }>): SearchDependencies & { urls: URL[] } {
  const urls: URL[] = [];
  let index = 0;
  return {
    urls,
    now,
    sleep: async () => undefined,
    fetch: async (input) => {
      urls.push(new URL(input instanceof Request ? input.url : input.toString()));
      const value = values[index++] ?? { body: "", status: 500 };
      return new Response(value.body, { status: value.status ?? 200, headers: value.headers });
    },
  };
}

describe("paper-search input schemas", () => {
  it("rejects unknown parameters instead of silently stripping them", () => {
    const parsed = arxivSearchInput.safeParse({ query: "protein design", max_results: 10, sort_by: "submitted_date" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("validates paired PubMed dates and incompatible relative dates", () => {
    expect(pubmedSearchInput.safeParse({ query: "cancer", date_from: "2025-01-01" }).success).toBe(false);
    expect(pubmedSearchInput.safeParse({ query: "cancer", date_from: "2025-01-01", date_to: "2026-01-01", relative_days: 30 }).success).toBe(false);
  });
});

describe("paper-search provider mapping", () => {
  it("maps arXiv category, pagination, and newest-first sorting and exposes effective parameters", async () => {
    const xml = `<?xml version="1.0"?><feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
      <opensearch:totalResults>42</opensearch:totalResults><entry><id>http://arxiv.org/abs/2609.01234v2</id><title>A &amp; B</title>
      <published>2026-09-05T01:02:03Z</published><updated>2026-09-06T01:02:03Z</updated><summary>Test abstract</summary>
      <author><name>Alice</name></author><category term="q-bio.BM"/><arxiv:primary_category term="q-bio.BM"/>
      <link href="https://arxiv.org/pdf/2609.01234" type="application/pdf"/></entry></feed>`;
    const dependencies = responses({ body: xml });
    const input = arxivSearchInput.parse({ query: "protein design", categories: ["q-bio.BM"], limit: 5, offset: 10, sort_by: "submitted_date", sort_order: "descending" });
    const result = await searchArxiv(input, dependencies);
    const url = dependencies.urls[0]!;
    expect(url.searchParams.get("search_query")).toBe("all:protein AND all:design AND (cat:q-bio.BM)");
    expect(url.searchParams.get("start")).toBe("10");
    expect(url.searchParams.get("max_results")).toBe("5");
    expect(url.searchParams.get("sortBy")).toBe("submittedDate");
    expect(url.searchParams.get("sortOrder")).toBe("descending");
    expect(result).toMatchObject({ retrieved_at: "2026-09-06T00:00:00.000Z", total: 42, count: 1, request: { sort_by: "submitted_date", offset: 10 }, records: [{ arxiv_id: "2609.01234", published_at: "2026-09-05T01:02:03Z", primary_category: "q-bio.BM", pdf_url: "https://arxiv.org/pdf/2609.01234" }] });
  });

  it("preserves an arXiv native query instead of prefixing it with all", async () => {
    const dependencies = responses({ body: "<feed><opensearch:totalResults>0</opensearch:totalResults></feed>" });
    const input = arxivSearchInput.parse({ query: "cat:q-bio.BM AND abs:\"protein design\"", query_mode: "native" });
    await searchArxiv(input, dependencies);
    expect(dependencies.urls[0]!.searchParams.get("search_query")).toBe("cat:q-bio.BM AND abs:\"protein design\"");
  });

  it("maps PubMed field, publication-date sort, dates, and offset", async () => {
    const dependencies = responses(
      { body: JSON.stringify({ esearchresult: { count: "12", idlist: ["123"] } }) },
      { body: JSON.stringify({ result: { 123: { title: "Paper", pubdate: "2026 Sep", source: "Nature", authors: [{ name: "A Author" }], articleids: [{ idtype: "doi", value: "10.1/test" }] } } }) },
    );
    const input = pubmedSearchInput.parse({ query: "protein design", search_field: "abstract", sort_by: "published_date", date_from: "2025-01-01", date_to: "2026-09-06", limit: 7, offset: 14 });
    const result = await searchPubmed(input, dependencies);
    const url = dependencies.urls[0]!;
    expect(Object.fromEntries(["retstart", "retmax", "sort", "field", "datetype", "mindate", "maxdate"].map((key) => [key, url.searchParams.get(key)]))).toEqual({ retstart: "14", retmax: "7", sort: "pub_date", field: "abstract", datetype: "pdat", mindate: "2025/01/01", maxdate: "2026/09/06" });
    expect(result).toMatchObject({ total: 12, count: 1, request: { sort_by: "published_date" }, records: [{ pmid: "123", doi: "10.1/test", published_at: "2026 Sep" }] });
  });

  it("maps Crossref fielded queries, filters, sorting, and pagination", async () => {
    const dependencies = responses({ body: JSON.stringify({ message: { "total-results": 9, items: [{ DOI: "10.1/example", title: ["Example"], published: { "date-parts": [[2026, 9, 5]] }, author: [{ given: "A", family: "Researcher" }], "references-count": 12 }] } }) });
    const input = crossrefSearchInput.parse({ query: "protein", title: "design", author: "Smith", container_title: "Nature", work_type: "journal-article", published_from: "2025-01-01", has_abstract: true, sort_by: "published", sort_order: "descending", offset: 20, limit: 10 });
    const result = await searchCrossref(input, dependencies);
    const url = dependencies.urls[0]!;
    expect(url.searchParams.get("query.title")).toBe("design");
    expect(url.searchParams.get("query.author")).toBe("Smith");
    expect(url.searchParams.get("query.container-title")).toBe("Nature");
    expect(url.searchParams.get("filter")).toBe("type:journal-article,from-pub-date:2025-01-01,has-abstract:true");
    expect(url.searchParams.get("sort")).toBe("published");
    expect(url.searchParams.get("order")).toBe("desc");
    expect(url.searchParams.get("offset")).toBe("20");
    expect(result).toMatchObject({ total: 9, count: 1, records: [{ doi: "10.1/example", published_at: "2026-09-05", year: 2026, reference_count: 12 }] });
  });

  it("retries transient provider failures and honors Retry-After", async () => {
    const waits: number[] = [];
    const dependencies = responses({ body: "busy", status: 429, headers: { "retry-after": "1" } }, { body: JSON.stringify({ message: { "total-results": 0, items: [] } }) });
    dependencies.sleep = async (milliseconds) => { waits.push(milliseconds); };
    await searchCrossref(crossrefSearchInput.parse({ query: "test" }), dependencies);
    expect(dependencies.urls).toHaveLength(2);
    expect(waits).toEqual([1_000]);
  });
});
