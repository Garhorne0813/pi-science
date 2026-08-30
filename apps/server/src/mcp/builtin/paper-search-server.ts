import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "pi-science-paper-search", version: "1.0.0" });
const searchInput = { query: z.string().min(1).max(500).describe("Scientific literature search query"), limit: z.number().int().min(1).max(50).default(10) };

server.registerTool("search_crossref", {
  title: "Search Crossref",
  description: "Search Crossref DOI metadata for scholarly works.",
  inputSchema: searchInput,
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ query, limit }) => result(await searchCrossref(query, limit)));

server.registerTool("search_pubmed", {
  title: "Search PubMed",
  description: "Search PubMed and return NCBI article summaries with PMIDs.",
  inputSchema: searchInput,
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ query, limit }) => result(await searchPubmed(query, limit)));

server.registerTool("search_arxiv", {
  title: "Search arXiv",
  description: "Search arXiv preprints and return identifiers, abstracts and links.",
  inputSchema: searchInput,
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ query, limit }) => result(await searchArxiv(query, limit)));

await server.connect(new StdioServerTransport());

async function searchCrossref(query: string, limit: number) {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query", query); url.searchParams.set("rows", String(limit)); url.searchParams.set("select", "DOI,title,author,published,container-title,URL,type");
  const payload = await json(url) as { message?: { items?: Array<Record<string, unknown>> } };
  return (payload.message?.items ?? []).map((item) => ({
    source: "crossref", doi: item.DOI ?? null, title: first(item.title), authors: authors(item.author), year: dateYear(item.published), venue: first(item["container-title"]), type: item.type ?? null, url: item.URL ?? null,
  }));
}

async function searchPubmed(query: string, limit: number) {
  const search = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
  search.searchParams.set("db", "pubmed"); search.searchParams.set("retmode", "json"); search.searchParams.set("retmax", String(limit)); search.searchParams.set("term", query);
  const found = await json(search) as { esearchresult?: { idlist?: string[] } };
  const ids = found.esearchresult?.idlist ?? [];
  if (!ids.length) return [];
  const summary = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
  summary.searchParams.set("db", "pubmed"); summary.searchParams.set("retmode", "json"); summary.searchParams.set("id", ids.join(","));
  const payload = await json(summary) as { result?: Record<string, Record<string, unknown>> };
  return ids.map((pmid) => { const item = payload.result?.[pmid] ?? {}; return { source: "pubmed", pmid, title: item.title ?? null, authors: Array.isArray(item.authors) ? item.authors.map((author) => typeof author === "object" && author ? (author as { name?: unknown }).name : author).filter(Boolean) : [], year: String(item.pubdate ?? "").match(/\b\d{4}\b/)?.[0] ?? null, venue: item.fulljournalname ?? item.source ?? null, doi: articleId(item.articleids, "doi"), url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` }; });
}

async function searchArxiv(query: string, limit: number) {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", `all:${query}`); url.searchParams.set("start", "0"); url.searchParams.set("max_results", String(limit));
  const xml = await text(url);
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => { const entry = match[1] ?? ""; const idUrl = tag(entry, "id"); const id = idUrl.split("/").at(-1)?.replace(/v\d+$/, "") ?? null; return { source: "arxiv", arxiv_id: id, title: clean(tag(entry, "title")), authors: [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((item) => clean(item[1] ?? "")), year: tag(entry, "published").slice(0, 4) || null, abstract: clean(tag(entry, "summary")), doi: tag(entry, "arxiv:doi") || null, url: id ? `https://arxiv.org/abs/${id}` : idUrl }; });
}

function result(records: unknown[]) { return { content: [{ type: "text" as const, text: JSON.stringify({ retrieved_at: new Date().toISOString(), count: records.length, records }, null, 2) }], structuredContent: { records } }; }
async function json(url: URL): Promise<unknown> { return (await request(url)).json(); }
async function text(url: URL): Promise<string> { return (await request(url)).text(); }
async function request(url: URL): Promise<Response> { const response = await fetch(url, { headers: { "user-agent": "Pi-Science paper-search/1.0 (mailto:research@example.invalid)", accept: "application/json, application/atom+xml, text/xml" }, signal: AbortSignal.timeout(20_000) }); if (!response.ok) throw new Error(`${url.hostname} returned HTTP ${response.status}`); return response; }
function first(value: unknown): unknown { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
function authors(value: unknown): string[] { return Array.isArray(value) ? value.map((item) => { const author = item as { given?: unknown; family?: unknown }; return [author.given, author.family].filter(Boolean).join(" "); }).filter(Boolean) : []; }
function dateYear(value: unknown): number | null { const parts = value && typeof value === "object" ? (value as { [key: string]: unknown })["date-parts"] : null; const year = Array.isArray(parts) && Array.isArray(parts[0]) ? Number(parts[0][0]) : NaN; return Number.isFinite(year) ? year : null; }
function articleId(value: unknown, type: string): unknown { return Array.isArray(value) ? (value.find((item) => typeof item === "object" && item && (item as { idtype?: unknown }).idtype === type) as { value?: unknown } | undefined)?.value ?? null : null; }
function tag(xml: string, name: string): string { return decode(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`))?.[1] ?? ""); }
function clean(value: string): string { return decode(value).replace(/\s+/g, " ").trim(); }
function decode(value: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => entities[entity.slice(1, -1)] ?? entity);
}
