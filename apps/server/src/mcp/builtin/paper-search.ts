import { createMcpFetch } from "../runtime-fetch.js";
import { z } from "zod";

const query = z.string().trim().min(1).max(2_000).describe("Search terms. Use plain text unless query_mode is 'native'.");
const limit = z.number().int().min(1).max(50).default(10).describe("Number of records to return (1-50).");
const offset = z.number().int().min(0).max(10_000).default(0).describe("Zero-based result offset for pagination.");
const isoDate = z.string().regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/, "Use YYYY, YYYY-MM, or YYYY-MM-DD");

export const arxivSearchInput = z.strictObject({
  query,
  limit,
  offset,
  query_mode: z.enum(["plain", "native"]).default("plain").describe("Use 'native' only when query contains arXiv field prefixes or Boolean syntax."),
  search_field: z.enum(["all", "title", "abstract", "author"]).default("all").describe("Field used for a plain-text query."),
  categories: z.array(z.string().regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)?$/)).max(20).optional().describe("arXiv categories, for example ['q-bio.BM', 'cs.LG']."),
  arxiv_ids: z.array(z.string().min(1).max(40)).max(50).optional().describe("Optional arXiv IDs used to restrict or directly retrieve results."),
  sort_by: z.enum(["relevance", "submitted_date", "updated_date"]).default("relevance").describe("Result ranking. Use submitted_date for the newest papers."),
  sort_order: z.enum(["ascending", "descending"]).default("descending"),
});

export const pubmedSearchInput = z.strictObject({
  query,
  limit,
  offset,
  search_field: z.enum(["all", "title", "abstract", "author", "journal"]).default("all"),
  sort_by: z.enum(["relevance", "published_date", "author", "journal"]).default("relevance").describe("PubMed controls the direction associated with each sort mode."),
  date_type: z.enum(["publication", "entrez", "modified"]).default("publication"),
  date_from: isoDate.optional().describe("Inclusive lower date bound; must be paired with date_to."),
  date_to: isoDate.optional().describe("Inclusive upper date bound; must be paired with date_from."),
  relative_days: z.number().int().min(0).max(36_500).optional().describe("Only return records from the last N days using date_type."),
}).superRefine((value, context) => {
  if (Boolean(value.date_from) !== Boolean(value.date_to)) context.addIssue({ code: "custom", message: "date_from and date_to must be provided together" });
  if (value.relative_days !== undefined && value.date_from) context.addIssue({ code: "custom", message: "relative_days cannot be combined with date_from/date_to" });
});

export const crossrefSearchInput = z.strictObject({
  query,
  limit,
  offset,
  title: z.string().trim().min(1).max(500).optional().describe("Terms restricted to work titles."),
  author: z.string().trim().min(1).max(300).optional().describe("Author-name terms."),
  container_title: z.string().trim().min(1).max(300).optional().describe("Journal, conference, or book title terms."),
  work_type: z.string().trim().min(1).max(100).optional().describe("Exact Crossref work type, for example journal-article or posted-content."),
  published_from: isoDate.optional().describe("Inclusive lower publication-date bound."),
  published_to: isoDate.optional().describe("Inclusive upper publication-date bound. For latest-work searches, use today's date to exclude erroneous future-dated metadata."),
  has_abstract: z.boolean().optional(),
  has_full_text: z.boolean().optional(),
  sort_by: z.enum(["relevance", "published", "updated", "indexed", "created", "citation_count", "reference_count"]).default("relevance"),
  sort_order: z.enum(["ascending", "descending"]).default("descending"),
}).superRefine((value, context) => {
  if (value.published_from && value.published_to && value.published_from > value.published_to) context.addIssue({ code: "custom", message: "published_from must not be after published_to" });
});

export type ArxivSearchInput = z.infer<typeof arxivSearchInput>;
export type PubmedSearchInput = z.infer<typeof pubmedSearchInput>;
export type CrossrefSearchInput = z.infer<typeof crossrefSearchInput>;

type Provider = "arxiv" | "pubmed" | "crossref";
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SearchDependencies {
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface EffectiveRequest extends Record<string, unknown> {
  provider: Provider;
  query: string;
  limit: number;
  offset: number;
}

export interface SearchEnvelope extends Record<string, unknown> {
  retrieved_at: string;
  count: number;
  total: number | null;
  request: EffectiveRequest;
  warnings: string[];
  records: Array<Record<string, unknown>>;
}

const lastRequestAt = new Map<Provider, number>();
const throttleTails = new Map<Provider, Promise<void>>();
const minimumInterval: Record<Provider, number> = { arxiv: 3_000, pubmed: 350, crossref: 50 };

export async function searchArxiv(input: ArxivSearchInput, dependencies: SearchDependencies = {}): Promise<SearchEnvelope> {
  const field = { all: "all", title: "ti", abstract: "abs", author: "au" }[input.search_field];
  const baseQuery = input.query_mode === "native" ? input.query : arxivPlainQuery(input.query, field);
  const categoryQuery = input.categories?.length ? `(${input.categories.map((category) => `cat:${category}`).join(" OR ")})` : "";
  const effectiveQuery = [baseQuery, categoryQuery].filter(Boolean).join(" AND ");
  const sortBy = { relevance: "relevance", submitted_date: "submittedDate", updated_date: "lastUpdatedDate" }[input.sort_by];
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", effectiveQuery);
  if (input.arxiv_ids?.length) url.searchParams.set("id_list", input.arxiv_ids.join(","));
  url.searchParams.set("start", String(input.offset));
  url.searchParams.set("max_results", String(input.limit));
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", input.sort_order);
  const xml = await requestText("arxiv", url, dependencies);
  const records = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
    const entry = match[1] ?? "";
    const idUrl = tag(entry, "id");
    const id = idUrl.split("/").at(-1)?.replace(/v\d+$/, "") ?? null;
    const categories = [...entry.matchAll(/<category\s+term=["']([^"']+)["'][^>]*\/?\s*>/g)].map((item) => decode(item[1] ?? ""));
    return {
      source: "arxiv", arxiv_id: id, title: clean(tag(entry, "title")), authors: [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((item) => clean(item[1] ?? "")),
      published_at: tag(entry, "published") || null, updated_at: tag(entry, "updated") || null, year: tag(entry, "published").slice(0, 4) || null,
      abstract: clean(tag(entry, "summary")), categories, primary_category: attribute(entry, "arxiv:primary_category", "term") || categories[0] || null,
      doi: tag(entry, "arxiv:doi") || null, url: id ? `https://arxiv.org/abs/${id}` : idUrl, pdf_url: link(entry, "application/pdf"),
    };
  });
  return envelope("arxiv", input, records, integerTag(xml, "opensearch:totalResults"), dependencies, { effective_query: effectiveQuery, sort_by: input.sort_by, sort_order: input.sort_order });
}

export async function searchPubmed(input: PubmedSearchInput, dependencies: SearchDependencies = {}): Promise<SearchEnvelope> {
  const field = { all: undefined, title: "title", abstract: "abstract", author: "author", journal: "journal" }[input.search_field];
  const sort = { relevance: "relevance", published_date: "pub_date", author: "Author", journal: "JournalName" }[input.sort_by];
  const dateType = { publication: "pdat", entrez: "edat", modified: "mdat" }[input.date_type];
  const search = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
  search.searchParams.set("db", "pubmed"); search.searchParams.set("retmode", "json"); search.searchParams.set("retstart", String(input.offset)); search.searchParams.set("retmax", String(input.limit)); search.searchParams.set("term", input.query); search.searchParams.set("sort", sort);
  if (field) search.searchParams.set("field", field);
  if (input.relative_days !== undefined) { search.searchParams.set("datetype", dateType); search.searchParams.set("reldate", String(input.relative_days)); }
  if (input.date_from && input.date_to) { search.searchParams.set("datetype", dateType); search.searchParams.set("mindate", input.date_from.replaceAll("-", "/")); search.searchParams.set("maxdate", input.date_to.replaceAll("-", "/")); }
  addNcbiIdentity(search);
  const found = await requestJson("pubmed", search, dependencies) as { esearchresult?: { idlist?: string[]; count?: string } };
  const ids = found.esearchresult?.idlist ?? [];
  let records: Array<Record<string, unknown>> = [];
  if (ids.length) {
    const summary = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
    summary.searchParams.set("db", "pubmed"); summary.searchParams.set("retmode", "json"); summary.searchParams.set("id", ids.join(",")); addNcbiIdentity(summary);
    const payload = await requestJson("pubmed", summary, dependencies) as { result?: Record<string, Record<string, unknown>> };
    records = ids.map((pmid) => { const item = payload.result?.[pmid] ?? {}; const publishedAt = String(item.pubdate ?? "") || null; return { source: "pubmed", pmid, title: item.title ?? null, authors: Array.isArray(item.authors) ? item.authors.map((author) => typeof author === "object" && author ? (author as { name?: unknown }).name : author).filter(Boolean) : [], published_at: publishedAt, year: String(publishedAt ?? "").match(/\b\d{4}\b/)?.[0] ?? null, venue: item.fulljournalname ?? item.source ?? null, doi: articleId(item.articleids, "doi"), url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` }; });
  }
  return envelope("pubmed", input, records, number(found.esearchresult?.count), dependencies, { effective_query: input.query, sort_by: input.sort_by, date_type: input.date_type });
}

export async function searchCrossref(input: CrossrefSearchInput, dependencies: SearchDependencies = {}): Promise<SearchEnvelope> {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query", input.query); url.searchParams.set("rows", String(input.limit)); url.searchParams.set("offset", String(input.offset));
  if (input.title) url.searchParams.set("query.title", input.title);
  if (input.author) url.searchParams.set("query.author", input.author);
  if (input.container_title) url.searchParams.set("query.container-title", input.container_title);
  const filters = [input.work_type && `type:${input.work_type}`, input.published_from && `from-pub-date:${input.published_from}`, input.published_to && `until-pub-date:${input.published_to}`, input.has_abstract !== undefined && `has-abstract:${input.has_abstract}`, input.has_full_text !== undefined && `has-full-text:${input.has_full_text}`].filter((value): value is string => Boolean(value));
  if (filters.length) url.searchParams.set("filter", filters.join(","));
  const sort = { relevance: "relevance", published: "published", updated: "updated", indexed: "indexed", created: "created", citation_count: "is-referenced-by-count", reference_count: "references-count" }[input.sort_by];
  url.searchParams.set("sort", sort); url.searchParams.set("order", input.sort_order === "ascending" ? "asc" : "desc");
  url.searchParams.set("select", "DOI,title,author,published,created,indexed,container-title,URL,type,abstract,is-referenced-by-count,references-count");
  const email = contactEmail(); if (email) url.searchParams.set("mailto", email);
  const payload = await requestJson("crossref", url, dependencies) as { message?: { items?: Array<Record<string, unknown>>; [key: string]: unknown } };
  const records = (payload.message?.items ?? []).map((item) => ({ source: "crossref", doi: item.DOI ?? null, title: first(item.title), authors: authors(item.author), published_at: dateParts(item.published), year: dateYear(item.published), venue: first(item["container-title"]), type: item.type ?? null, abstract: item.abstract ?? null, citation_count: item["is-referenced-by-count"] ?? null, reference_count: item["references-count"] ?? null, url: item.URL ?? null }));
  return envelope("crossref", input, records, number(payload.message?.["total-results"]), dependencies, { effective_query: input.query, sort_by: input.sort_by, sort_order: input.sort_order, filters });
}

function envelope(provider: Provider, input: { query: string; limit: number; offset: number }, records: Array<Record<string, unknown>>, total: number | null, dependencies: SearchDependencies, effective: Record<string, unknown>): SearchEnvelope { return { retrieved_at: (dependencies.now?.() ?? new Date()).toISOString(), count: records.length, total, request: { provider, query: input.query, limit: input.limit, offset: input.offset, ...effective }, warnings: [], records }; }
async function requestJson(provider: Provider, url: URL, dependencies: SearchDependencies): Promise<unknown> { return (await request(provider, url, dependencies)).json(); }
async function requestText(provider: Provider, url: URL, dependencies: SearchDependencies): Promise<string> { return (await request(provider, url, dependencies)).text(); }
async function request(provider: Provider, url: URL, dependencies: SearchDependencies): Promise<Response> {
  const fetcher = dependencies.fetch ?? createMcpFetch({ connectorId: "mcp_builtin_paper_search", endpoint: url.origin, allowPrivate: false });
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!dependencies.fetch) await throttle(provider, sleep);
    const response = await fetcher(url, { headers: { "user-agent": userAgent(), accept: "application/json, application/atom+xml, text/xml" }, signal: AbortSignal.timeout(20_000) });
    if (response.ok) return response;
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) { const header = response.headers.get("retry-after"); const retryAfter = header === null ? Number.NaN : Number(header); await response.body?.cancel(); await sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1_000, 30_000) : 500 * 2 ** attempt); continue; }
    throw new Error(`${url.hostname} returned HTTP ${response.status}`);
  }
  throw new Error(`${url.hostname} request failed`);
}

async function throttle(provider: Provider, sleep: (milliseconds: number) => Promise<void>): Promise<void> {
  const predecessor = throttleTails.get(provider) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = predecessor.then(() => turn);
  throttleTails.set(provider, tail);
  try {
    await predecessor;
    const wait = (lastRequestAt.get(provider) ?? 0) + minimumInterval[provider] - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt.set(provider, Date.now());
  } finally {
    release();
    if (throttleTails.get(provider) === tail) throttleTails.delete(provider);
  }
}
function contactEmail(): string | null { const value = process.env.PI_SCIENCE_CONTACT_EMAIL?.trim(); return value && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? value : null; }
function userAgent(): string { const email = contactEmail(); return `Pi-Science paper-search/1.1${email ? ` (mailto:${email})` : ""}`; }
function addNcbiIdentity(url: URL): void { url.searchParams.set("tool", "pi_science"); const email = contactEmail(); if (email) url.searchParams.set("email", email); const apiKey = process.env.NCBI_API_KEY?.trim(); if (apiKey) url.searchParams.set("api_key", apiKey); }
function arxivPlainQuery(value: string, field: string): string { const terms = [...value.matchAll(/"[^"]+"|\S+/g)].map((match) => match[0]); return terms.map((term) => `${field}:${term}`).join(" AND "); }
function first(value: unknown): unknown { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
function authors(value: unknown): string[] { return Array.isArray(value) ? value.map((item) => { const author = item as { given?: unknown; family?: unknown }; return [author.given, author.family].filter(Boolean).join(" "); }).filter(Boolean) : []; }
function dateParts(value: unknown): string | null { const parts = value && typeof value === "object" ? (value as { [key: string]: unknown })["date-parts"] : null; const date = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0].map(String) : []; return date.length ? date.map((part, index) => index === 0 ? part : part.padStart(2, "0")).join("-") : null; }
function dateYear(value: unknown): number | null { const valueDate = dateParts(value); const year = Number(valueDate?.slice(0, 4)); return Number.isFinite(year) ? year : null; }
function articleId(value: unknown, type: string): unknown { return Array.isArray(value) ? (value.find((item) => typeof item === "object" && item && (item as { idtype?: unknown }).idtype === type) as { value?: unknown } | undefined)?.value ?? null : null; }
function tag(xml: string, name: string): string { return decode(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`))?.[1] ?? ""); }
function attribute(xml: string, name: string, attributeName: string): string { return decode(xml.match(new RegExp(`<${name}\\s+[^>]*${attributeName}=["']([^"']+)["'][^>]*>`))?.[1] ?? ""); }
function link(xml: string, type: string): string | null { const element = xml.match(new RegExp(`<link\\s+[^>]*type=["']${type.replace("/", "\\/")}["'][^>]*>`))?.[0] ?? ""; return attribute(element, "link", "href") || null; }
function integerTag(xml: string, name: string): number | null { return number(tag(xml, name)); }
function number(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function clean(value: string): string { return decode(value).replace(/\s+/g, " ").trim(); }
function decode(value: string): string { const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'" }; return value.replace(/&(amp|lt|gt|quot|apos|#39);/g, (entity) => entities[entity.slice(1, -1)] ?? entity).replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code))).replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16))); }
