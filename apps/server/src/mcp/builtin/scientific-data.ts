import { createMcpFetch } from "../runtime-fetch.js";
import { z } from "zod";

const pageSize = z.number().int().min(1).max(100).default(20);
const offset = z.number().int().min(0).max(10_000).default(0);
const identifier = z.string().trim().min(1).max(300);
const searchText = z.string().trim().min(1).max(1_000);

export const openAlexSearchInput = z.strictObject({
  query: searchText,
  per_page: pageSize,
  page: z.number().int().min(1).max(10_000).default(1),
  publication_year_from: z.number().int().min(1600).max(2200).optional(),
  publication_year_to: z.number().int().min(1600).max(2200).optional(),
  work_type: z.string().regex(/^[a-z][a-z0-9-]*$/).optional().describe("OpenAlex work type, for example article, preprint, dataset, or book-chapter."),
  open_access: z.boolean().optional(),
  author_id: z.string().regex(/^(?:https:\/\/openalex\.org\/)?A\d+$/i).optional(),
  source_id: z.string().regex(/^(?:https:\/\/openalex\.org\/)?S\d+$/i).optional(),
  sort_by: z.enum(["relevance", "citation_count", "publication_date"]).default("relevance"),
  sort_order: z.enum(["ascending", "descending"]).default("descending"),
}).superRefine((value, context) => {
  if (value.publication_year_from && value.publication_year_to && value.publication_year_from > value.publication_year_to) context.addIssue({ code: "custom", message: "publication_year_from must not be after publication_year_to" });
});
export const openAlexWorkInput = z.strictObject({ work_id: identifier.describe("OpenAlex W-id, DOI, PMID, or canonical URL.") });
export const openAlexCitationsInput = z.strictObject({ work_id: identifier, per_page: pageSize, cursor: z.string().min(1).max(2_000).default("*") });

export const clinicalTrialsSearchInput = z.strictObject({
  query: searchText.optional().describe("General AREA/Essie query."),
  condition: z.string().trim().min(1).max(500).optional(),
  intervention: z.string().trim().min(1).max(500).optional(),
  location: z.string().trim().min(1).max(500).optional(),
  overall_status: z.array(z.enum(["ACTIVE_NOT_RECRUITING", "COMPLETED", "ENROLLING_BY_INVITATION", "NOT_YET_RECRUITING", "RECRUITING", "SUSPENDED", "TERMINATED", "WITHDRAWN", "AVAILABLE", "NO_LONGER_AVAILABLE", "TEMPORARILY_NOT_AVAILABLE", "APPROVED_FOR_MARKETING", "WITHHELD", "UNKNOWN"])).max(14).optional(),
  phase: z.array(z.enum(["NA", "EARLY_PHASE1", "PHASE1", "PHASE2", "PHASE3", "PHASE4"])).max(6).optional(),
  study_type: z.enum(["INTERVENTIONAL", "OBSERVATIONAL", "EXPANDED_ACCESS"]).optional(),
  page_size: pageSize,
  page_token: z.string().min(1).max(2_000).optional(),
  sort_by: z.enum(["relevance", "last_update", "start_date"]).default("relevance"),
}).refine((value) => Boolean(value.query || value.condition || value.intervention || value.location || value.overall_status?.length || value.phase?.length || value.study_type), { message: "Provide at least one query or filter" });
export const clinicalTrialInput = z.strictObject({ nct_id: z.string().trim().regex(/^NCT\d{8}$/i) });

export const pdbSearchInput = z.strictObject({
  query: searchText,
  return_type: z.enum(["entry", "polymer_entity"]).default("entry"),
  limit: pageSize,
  offset,
});
export const pdbEntryInput = z.strictObject({ pdb_id: z.string().trim().regex(/^[0-9][A-Za-z0-9]{3}$/).transform((value) => value.toUpperCase()) });
export const alphaFoldInput = z.strictObject({ uniprot_accession: z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{4,19}$/i).transform((value) => value.toUpperCase()) });

export const myGeneInput = z.strictObject({
  query: searchText,
  species: z.union([z.enum(["human", "mouse", "rat", "all"]), z.number().int().positive()]).default("human"),
  fields: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/)).max(30).default(["symbol", "name", "entrezgene", "ensembl.gene", "uniprot.Swiss-Prot", "taxid"]),
  size: pageSize,
  offset,
});
export const ontologySearchInput = z.strictObject({
  query: searchText,
  ontology: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).optional().describe("OLS ontology short name, such as cl, go, mondo, or efo."),
  exact: z.boolean().default(false),
  include_obsolete: z.boolean().default(false),
  rows: pageSize,
  start: offset,
});
export const reactomePathwayInput = z.strictObject({
  uniprot_accession: z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{4,19}$/i).transform((value) => value.toUpperCase()),
  species: z.string().trim().min(1).max(100).default("Homo sapiens"),
});

export const ensemblLookupInput = z.strictObject({
  ensembl_id: z.string().trim().regex(/^ENS[A-Z]*[GPT]\d+(?:\.\d+)?$/i),
  expand: z.boolean().default(false),
  mane: z.boolean().default(false),
  phenotypes: z.boolean().default(false),
});
export const ensemblSequenceInput = z.strictObject({
  ensembl_id: z.string().trim().regex(/^ENS[A-Z]*[GPT]\d+(?:\.\d+)?$/i),
  sequence_type: z.enum(["genomic", "cdna", "cds", "protein"]).default("genomic"),
  multiple_sequences: z.boolean().default(false),
});
export const ensemblVepInput = z.strictObject({
  region: z.string().trim().regex(/^(?:chr)?[A-Za-z0-9_.]+:\d+-\d+(?::[+-])?$/).describe("Human genomic region, for example 9:22125503-22125503 or X:153296777-153296777:-."),
  allele: z.string().trim().regex(/^(?:[ACGTN]+|-)\/(?:[ACGTN]+|-)$/i).describe("Reference/alternate allele, for example G/A or -/T."),
  canonical: z.boolean().default(true),
  mane: z.boolean().default(true),
  protein: z.boolean().default(true),
});

export const cellTypeSearchInput = z.strictObject({ query: searchText, limit: z.number().int().min(1).max(50).default(20) });
export const cellTypeInput = z.strictObject({ cell_ontology_id: z.string().trim().regex(/^CL:\d{7}$/i).transform((value) => value.toUpperCase()) });

export type ScientificDependencies = { fetch?: typeof fetch; now?: () => Date; sleep?: (milliseconds: number) => Promise<void> };
type Json = Record<string, unknown>;

export async function searchOpenAlexWorks(input: z.infer<typeof openAlexSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", input.query); url.searchParams.set("per-page", String(input.per_page)); url.searchParams.set("page", String(input.page));
  const filters = [input.publication_year_from && `from_publication_date:${input.publication_year_from}-01-01`, input.publication_year_to && `to_publication_date:${input.publication_year_to}-12-31`, input.work_type && `type:${input.work_type}`, input.open_access !== undefined && `is_oa:${input.open_access}`, input.author_id && `author.id:${openAlexId(input.author_id)}`, input.source_id && `primary_location.source.id:${openAlexId(input.source_id)}`].filter((value): value is string => Boolean(value));
  if (filters.length) url.searchParams.set("filter", filters.join(","));
  const sort = { relevance: "relevance_score", citation_count: "cited_by_count", publication_date: "publication_date" }[input.sort_by];
  url.searchParams.set("sort", `${sort}:${input.sort_order === "ascending" ? "asc" : "desc"}`); addOpenAlexIdentity(url);
  const payload = await getJson("literature_graph", url, dependencies) as { meta?: Json; results?: Json[] };
  return envelope("openalex", { ...input, filters }, (payload.results ?? []).map(compactOpenAlexWork), numeric(payload.meta?.count), dependencies, payload.meta?.next_cursor);
}

export async function getOpenAlexWork(input: z.infer<typeof openAlexWorkInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://api.openalex.org/works/${encodeURIComponent(normalizeOpenAlexWorkId(input.work_id))}`); addOpenAlexIdentity(url);
  const work = await getJson("literature_graph", url, dependencies) as Json;
  return singleEnvelope("openalex", input, compactOpenAlexWork(work), dependencies);
}

export async function getOpenAlexCitations(input: z.infer<typeof openAlexCitationsInput>, dependencies: ScientificDependencies = {}) {
  let workId = normalizeOpenAlexWorkId(input.work_id);
  if (!/^W\d+$/i.test(workId)) {
    const resolved = await getOpenAlexWork({ work_id: input.work_id }, dependencies);
    workId = openAlexId(String((resolved.record as Json).openalex_id ?? ""));
  }
  const url = new URL("https://api.openalex.org/works"); url.searchParams.set("filter", `cites:${workId}`); url.searchParams.set("per-page", String(input.per_page)); url.searchParams.set("cursor", input.cursor); url.searchParams.set("sort", "cited_by_count:desc"); addOpenAlexIdentity(url);
  const payload = await getJson("literature_graph", url, dependencies) as { meta?: Json; results?: Json[] };
  return envelope("openalex", { ...input, resolved_work_id: workId }, (payload.results ?? []).map(compactOpenAlexWork), numeric(payload.meta?.count), dependencies, payload.meta?.next_cursor);
}

export async function searchClinicalTrials(input: z.infer<typeof clinicalTrialsSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://clinicaltrials.gov/api/v2/studies");
  if (input.query) url.searchParams.set("query.term", input.query); if (input.condition) url.searchParams.set("query.cond", input.condition); if (input.intervention) url.searchParams.set("query.intr", input.intervention); if (input.location) url.searchParams.set("query.locn", input.location);
  if (input.overall_status?.length) url.searchParams.set("filter.overallStatus", input.overall_status.join("|"));
  const advanced = [input.phase?.length && `AREA[Phase](${input.phase.join(" OR ")})`, input.study_type && `AREA[StudyType]${input.study_type}`].filter(Boolean).join(" AND ");
  if (advanced) url.searchParams.set("filter.advanced", advanced); url.searchParams.set("pageSize", String(input.page_size)); if (input.page_token) url.searchParams.set("pageToken", input.page_token); url.searchParams.set("format", "json");
  if (input.sort_by !== "relevance") url.searchParams.set("sort", input.sort_by === "last_update" ? "LastUpdatePostDate:desc" : "StudyStartDate:desc");
  const payload = await getJson("clinical_trials", url, dependencies) as { studies?: Json[]; totalCount?: number; nextPageToken?: string };
  return envelope("clinicaltrials.gov", input, (payload.studies ?? []).map(compactTrial), payload.totalCount ?? null, dependencies, payload.nextPageToken);
}

export async function getClinicalTrial(input: z.infer<typeof clinicalTrialInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://clinicaltrials.gov/api/v2/studies/${input.nct_id.toUpperCase()}`); url.searchParams.set("format", "json");
  return singleEnvelope("clinicaltrials.gov", input, compactTrial(await getJson("clinical_trials", url, dependencies) as Json), dependencies);
}

export async function searchPdbEntries(input: z.infer<typeof pdbSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://search.rcsb.org/rcsbsearch/v2/query");
  const body = { query: { type: "terminal", service: "full_text", parameters: { value: input.query } }, return_type: input.return_type, request_options: { paginate: { start: input.offset, rows: input.limit }, results_content_type: ["experimental"] } };
  const payload = await requestJson("structures", url, dependencies, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as { total_count?: number; result_set?: Json[] };
  return envelope("rcsb-pdb", input, (payload.result_set ?? []).map((item) => ({ identifier: item.identifier, score: item.score })), payload.total_count ?? null, dependencies);
}

export async function getPdbEntry(input: z.infer<typeof pdbEntryInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://data.rcsb.org/rest/v1/core/entry/${input.pdb_id}`);
  return singleEnvelope("rcsb-pdb", input, await getJson("structures", url, dependencies) as Json, dependencies);
}

export async function getAlphaFoldPrediction(input: z.infer<typeof alphaFoldInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://alphafold.ebi.ac.uk/api/prediction/${input.uniprot_accession}`);
  const payload = await getJson("structures", url, dependencies);
  return envelope("alphafold-db", input, Array.isArray(payload) ? payload as Json[] : [payload as Json], null, dependencies);
}

export async function queryMyGene(input: z.infer<typeof myGeneInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://mygene.info/v3/query"); url.searchParams.set("q", input.query); url.searchParams.set("species", String(input.species)); url.searchParams.set("fields", input.fields.join(",")); url.searchParams.set("size", String(input.size)); url.searchParams.set("from", String(input.offset));
  const payload = await getJson("genes_ontologies", url, dependencies) as { total?: number; hits?: Json[] };
  return envelope("mygene.info", input, payload.hits ?? [], payload.total ?? null, dependencies);
}

export async function searchOntologyTerms(input: z.infer<typeof ontologySearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.ebi.ac.uk/ols4/api/search"); url.searchParams.set("q", input.query); if (input.ontology) url.searchParams.set("ontology", input.ontology.toLowerCase()); url.searchParams.set("exact", String(input.exact)); url.searchParams.set("obsoletes", String(input.include_obsolete)); url.searchParams.set("rows", String(input.rows)); url.searchParams.set("start", String(input.start));
  const payload = await getJson("genes_ontologies", url, dependencies) as { response?: { numFound?: number; docs?: Json[] } };
  return envelope("ebi-ols", input, payload.response?.docs ?? [], payload.response?.numFound ?? null, dependencies);
}

export async function mapReactomePathways(input: z.infer<typeof reactomePathwayInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://reactome.org/ContentService/data/mapping/UniProt/${encodeURIComponent(input.uniprot_accession)}/pathways`); url.searchParams.set("species", input.species);
  const payload = await getJson("genes_ontologies", url, dependencies);
  return envelope("reactome", input, Array.isArray(payload) ? payload as Json[] : [], null, dependencies);
}

export async function lookupEnsemblId(input: z.infer<typeof ensemblLookupInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://rest.ensembl.org/lookup/id/${encodeURIComponent(input.ensembl_id)}`); url.searchParams.set("expand", input.expand ? "1" : "0"); url.searchParams.set("mane", input.mane ? "1" : "0"); url.searchParams.set("phenotypes", input.phenotypes ? "1" : "0");
  return singleEnvelope("ensembl", input, await getJson("genomes", url, dependencies) as Json, dependencies);
}

export async function getEnsemblSequence(input: z.infer<typeof ensemblSequenceInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://rest.ensembl.org/sequence/id/${encodeURIComponent(input.ensembl_id)}`); url.searchParams.set("type", input.sequence_type); url.searchParams.set("multiple_sequences", input.multiple_sequences ? "1" : "0");
  return singleEnvelope("ensembl", input, await getJson("genomes", url, dependencies) as Json, dependencies);
}

export async function runEnsemblVep(input: z.infer<typeof ensemblVepInput>, dependencies: ScientificDependencies = {}) {
  const region = input.region.replace(/^chr/i, ""); const url = new URL(`https://rest.ensembl.org/vep/human/region/${encodeURIComponent(region)}/${encodeURIComponent(input.allele)}`); url.searchParams.set("canonical", input.canonical ? "1" : "0"); url.searchParams.set("mane", input.mane ? "1" : "0"); url.searchParams.set("protein", input.protein ? "1" : "0");
  const payload = await getJson("genomes", url, dependencies);
  return envelope("ensembl-vep", { ...input, region }, Array.isArray(payload) ? payload as Json[] : [], null, dependencies);
}

export async function searchCellTypes(input: z.infer<typeof cellTypeSearchInput>, dependencies: ScientificDependencies = {}) {
  const { snapshot, metadata } = await cellGuideMetadata(dependencies); const terms = input.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const records = Object.values(metadata).filter((record) => { const haystack = [record.id, record.name, record.clDescription, ...(Array.isArray(record.synonyms) ? record.synonyms : [])].join(" ").toLocaleLowerCase(); return terms.every((term) => haystack.includes(term)); }).slice(0, input.limit);
  return envelope("cellxgene-cellguide", { ...input, snapshot }, records, records.length, dependencies);
}

export async function getCellType(input: z.infer<typeof cellTypeInput>, dependencies: ScientificDependencies = {}) {
  const { snapshot, metadata } = await cellGuideMetadata(dependencies); const record = metadata[input.cell_ontology_id];
  if (!record) throw new Error(`CellGuide has no record for ${input.cell_ontology_id}`);
  return singleEnvelope("cellxgene-cellguide", { ...input, snapshot }, record, dependencies);
}

async function cellGuideMetadata(dependencies: ScientificDependencies): Promise<{ snapshot: string; metadata: Record<string, Json> }> {
  if (!dependencies.fetch && cellGuideCache && cellGuideCache.expiresAt > Date.now()) return cellGuideCache.value;
  const snapshotValue = await requestText("cellguide", new URL("https://cellguide.cellxgene.cziscience.com/latest_snapshot_identifier"), dependencies);
  const snapshot = snapshotValue.trim().replace(/^"|"$/g, ""); if (!/^\d+$/.test(snapshot)) throw new Error("CellGuide returned an invalid snapshot identifier");
  const metadata = await getJson("cellguide", new URL(`https://cellguide.cellxgene.cziscience.com/${snapshot}/celltype_metadata.json`), dependencies) as Record<string, Json>;
  const value = { snapshot, metadata };
  if (!dependencies.fetch) cellGuideCache = { value, expiresAt: Date.now() + 60 * 60 * 1_000 };
  return value;
}

let cellGuideCache: { value: { snapshot: string; metadata: Record<string, Json> }; expiresAt: number } | null = null;
const connectorIds: Record<string, string> = {
  literature_graph: "mcp_builtin_literature_graph", clinical_trials: "mcp_builtin_clinical_trials", structures: "mcp_builtin_structures", genes_ontologies: "mcp_builtin_genes_ontologies", genomes: "mcp_builtin_genomes", cellguide: "mcp_builtin_cellguide",
  protein_annotation: "mcp_builtin_protein_annotation", omics_archives: "mcp_builtin_omics_archives", chemistry: "mcp_builtin_chemistry", regulation: "mcp_builtin_regulation", biomart: "mcp_builtin_biomart", drug_regulatory: "mcp_builtin_drug_regulatory", human_genetics: "mcp_builtin_human_genetics",
  protein_records: "mcp_builtin_protein_records", nucleotide_archives: "mcp_builtin_nucleotide_archives", target_discovery: "mcp_builtin_target_discovery", chembl: "mcp_builtin_chembl",
};
export async function getJson(domain: string, url: URL, dependencies: ScientificDependencies) { return requestJson(domain, url, dependencies, { headers: { accept: "application/json" } }); }
export async function requestJson(domain: string, url: URL, dependencies: ScientificDependencies, init: RequestInit = {}): Promise<unknown> { return JSON.parse(await requestText(domain, url, dependencies, init)); }
export async function requestText(domain: string, url: URL, dependencies: ScientificDependencies, init: RequestInit = {}): Promise<string> {
  return (await requestTextWithHeaders(domain, url, dependencies, init)).text;
}
export async function requestTextWithHeaders(domain: string, url: URL, dependencies: ScientificDependencies, init: RequestInit = {}): Promise<{ text: string; headers: Headers }> {
  const fetcher = dependencies.fetch ?? createMcpFetch({ connectorId: connectorIds[domain] ?? `mcp_builtin_${domain}`, endpoint: url.origin, allowPrivate: false }); const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetcher(url, { ...init, headers: { "user-agent": "Pi-Science scientific-data/1.0", ...Object.fromEntries(new Headers(init.headers).entries()) }, signal: init.signal ?? AbortSignal.timeout(25_000) });
    if (response.ok) { const text = await response.text(); if (text.length > 15_000_000) throw new Error(`${url.hostname} response exceeded 15 MB`); return { text, headers: response.headers }; }
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) { const retry = Number(response.headers.get("retry-after")); await response.body?.cancel(); await sleep(Number.isFinite(retry) ? Math.min(retry * 1_000, 30_000) : 500 * 2 ** attempt); continue; }
    const detail = (await response.text()).slice(0, 300).replace(/\s+/g, " "); throw new Error(`${url.hostname} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  throw new Error(`${url.hostname} request failed`);
}

function addOpenAlexIdentity(url: URL) { const key = process.env.OPENALEX_API_KEY?.trim(); if (key) url.searchParams.set("api_key", key); const email = process.env.PI_SCIENCE_CONTACT_EMAIL?.trim(); if (email) url.searchParams.set("mailto", email); }
function normalizeOpenAlexWorkId(value: string) { const trimmed = value.trim(); if (/^W\d+$/i.test(trimmed)) return trimmed.toUpperCase(); if (/^https?:\/\/openalex\.org\/W\d+$/i.test(trimmed)) return openAlexId(trimmed); if (/^PMID:\d+$/i.test(trimmed)) return trimmed.toLowerCase(); if (/^https?:\/\/doi\.org\//i.test(trimmed)) return trimmed; if (/^10\.\d{4,9}\//.test(trimmed)) return `https://doi.org/${trimmed}`; return trimmed; }
function openAlexId(value: string) { return value.split("/").at(-1)?.toUpperCase() ?? value; }
function compactOpenAlexWork(work: Json) { const primary = object(work.primary_location); const source = object(primary.source); return { openalex_id: work.id, doi: work.doi, title: work.title ?? work.display_name, publication_year: work.publication_year, publication_date: work.publication_date, type: work.type, cited_by_count: work.cited_by_count, open_access: work.open_access, authors: Array.isArray(work.authorships) ? work.authorships.slice(0, 50).map((item) => object(object(item).author).display_name).filter(Boolean) : [], source: source.display_name, landing_page_url: primary.landing_page_url, referenced_works: work.referenced_works }; }
function compactTrial(study: Json) { const protocol = object(study.protocolSection); const identification = object(protocol.identificationModule); const status = object(protocol.statusModule); const design = object(protocol.designModule); const conditions = object(protocol.conditionsModule); const contacts = object(protocol.contactsLocationsModule); return { nct_id: identification.nctId, brief_title: identification.briefTitle, official_title: identification.officialTitle, overall_status: status.overallStatus, start_date: object(status.startDateStruct).date, completion_date: object(status.completionDateStruct).date, phases: design.phases, study_type: design.studyType, conditions: conditions.conditions, keywords: conditions.keywords, locations: Array.isArray(contacts.locations) ? contacts.locations.slice(0, 20) : [], url: identification.nctId ? `https://clinicaltrials.gov/study/${identification.nctId}` : null }; }
export function envelope(source: string, request: Json, records: Json[], total: number | null, dependencies: ScientificDependencies, next?: unknown) { return { source, retrieved_at: (dependencies.now?.() ?? new Date()).toISOString(), request, count: records.length, total, ...(next ? { next_page_token: next } : {}), records }; }
export function singleEnvelope(source: string, request: Json, record: Json, dependencies: ScientificDependencies) { return { source, retrieved_at: (dependencies.now?.() ?? new Date()).toISOString(), request, record }; }
export function object(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
export function numeric(value: unknown): number | null { const result = Number(value); return Number.isFinite(result) ? result : null; }
