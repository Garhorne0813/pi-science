import { z } from "zod";
import { envelope, getJson, numeric, object, requestJson, requestText, singleEnvelope, type ScientificDependencies } from "./scientific-data.js";

const query = z.string().trim().min(1).max(1_000);
const pageSize = z.number().int().min(1).max(100).default(20);
const page = z.number().int().min(0).max(10_000).default(0);
const uniprot = z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{4,19}$/i).transform((value) => value.toUpperCase());

export const interproSearchInput = z.strictObject({ query, entry_type: z.enum(["all", "family", "domain", "repeat", "site", "homologous_superfamily"]).default("all"), page_size: pageSize, cursor: z.string().min(1).max(2_000).optional() });
export const interproProteinInput = z.strictObject({ uniprot_accession: uniprot, page_size: pageSize, cursor: z.string().min(1).max(2_000).optional() });
export const stringNetworkInput = z.strictObject({ identifiers: z.array(z.string().trim().min(1).max(100)).min(1).max(10), species: z.number().int().positive().default(9606), required_score: z.number().int().min(0).max(1_000).default(400), network_type: z.enum(["functional", "physical"]).default("functional"), add_nodes: z.number().int().min(0).max(20).default(0) });

export const geoSearchInput = z.strictObject({ query, limit: z.number().int().min(1).max(50).default(20), offset: page, sort_by: z.enum(["relevance", "date"]).default("relevance") });
export const prideSearchInput = z.strictObject({ keyword: query, page, page_size: pageSize });
export const mgnifySearchInput = z.strictObject({ query, page: z.number().int().min(1).max(10_000).default(1), page_size: pageSize });

export const pubchemSearchInput = z.strictObject({ name: query, max_records: z.number().int().min(1).max(100).default(20) });
export const pubchemCompoundInput = z.strictObject({ cid: z.number().int().positive(), synonym_limit: z.number().int().min(0).max(100).default(25) });
export const chebiSearchInput = z.strictObject({ query, page: z.number().int().min(1).max(10_000).default(1), page_size: pageSize });

export const encodeSearchInput = z.strictObject({ query, record_type: z.enum(["Experiment", "Biosample", "File", "Annotation"]).default("Experiment"), status: z.enum(["released", "archived", "revoked", "in progress"]).default("released"), limit: z.number().int().min(1).max(100).default(20) });
export const encodeRecordInput = z.strictObject({ accession: z.string().trim().regex(/^ENC[A-Z0-9]{8,}$/i).transform((value) => value.toUpperCase()) });
export const jasparSearchInput = z.strictObject({ query, collection: z.enum(["CORE", "CNE", "PHYLOFACTS", "SPLICE", "POLII", "FAM", "UNVALIDATED"]).optional(), tax_id: z.array(z.number().int().positive()).max(20).optional(), page: z.number().int().min(1).max(10_000).default(1), page_size: pageSize, order: z.enum(["matrix_id", "name", "-matrix_id", "-name"]).default("matrix_id") });

const biomartName = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/);
export const biomartDatasetsInput = z.strictObject({ mart: biomartName.default("ENSEMBL_MART_ENSEMBL"), include_archived: z.boolean().default(false) });
export const biomartQueryInput = z.strictObject({ dataset: biomartName, attributes: z.array(biomartName).min(1).max(30), filters: z.record(biomartName, z.union([z.string().max(2_000), z.number(), z.boolean(), z.array(z.union([z.string().max(300), z.number()])).max(100)])).default({}), limit: z.number().int().min(1).max(10_000).default(100), unique_rows: z.boolean().default(true) });

export const openFdaLabelSearchInput = z.strictObject({ query, field: z.enum(["generic_name", "brand_name", "substance_name", "manufacturer_name", "indications_and_usage"]).default("generic_name"), limit: z.number().int().min(1).max(100).default(20), skip: z.number().int().min(0).max(25_000).default(0) });
export const openFdaLabelInput = z.strictObject({ set_id: z.string().trim().regex(/^[A-Fa-f0-9-]{20,50}$/) });
export const drugsFdaSearchInput = z.strictObject({ query, field: z.enum(["active_ingredient", "sponsor_name", "application_number"]).default("active_ingredient"), limit: z.number().int().min(1).max(100).default(20), skip: z.number().int().min(0).max(25_000).default(0) });

export const gwasStudiesInput = z.strictObject({ disease_trait: z.string().trim().min(1).max(500).optional(), efo_trait: z.string().trim().min(1).max(500).optional(), pubmed_id: z.number().int().positive().optional(), accession_id: z.string().trim().regex(/^GCST\d+$/i).optional(), page, page_size: pageSize }).refine((value) => Boolean(value.disease_trait || value.efo_trait || value.pubmed_id || value.accession_id), { message: "Provide at least one GWAS study filter" });
export const gwasAssociationsInput = z.strictObject({ efo_trait: z.string().trim().min(1).max(500).optional(), rs_id: z.string().trim().regex(/^rs\d+$/i).optional(), mapped_gene: z.string().trim().min(1).max(100).optional(), accession_id: z.string().trim().regex(/^GCST\d+$/i).optional(), page, page_size: pageSize }).refine((value) => Boolean(value.efo_trait || value.rs_id || value.mapped_gene || value.accession_id), { message: "Provide at least one GWAS association filter" });
export const gwasStudyInput = z.strictObject({ accession_id: z.string().trim().regex(/^GCST\d+$/i).transform((value) => value.toUpperCase()) });

type Json = Record<string, unknown>;

export async function searchInterproEntries(input: z.infer<typeof interproSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.ebi.ac.uk/interpro/api/entry/interpro/"); url.searchParams.set("search", input.query); url.searchParams.set("page_size", String(input.page_size)); if (input.entry_type !== "all") url.searchParams.set("type", input.entry_type); if (input.cursor) url.searchParams.set("cursor", input.cursor);
  const payload = await getJson("protein_annotation", url, dependencies) as Json; return envelope("interpro", input, rows(payload.results).map(compactInterpro), numeric(payload.count), dependencies, cursorFromUrl(payload.next));
}

export async function getInterproProteinAnnotations(input: z.infer<typeof interproProteinInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://www.ebi.ac.uk/interpro/api/entry/interpro/protein/uniprot/${input.uniprot_accession}/`); url.searchParams.set("page_size", String(input.page_size)); if (input.cursor) url.searchParams.set("cursor", input.cursor);
  const payload = await getJson("protein_annotation", url, dependencies) as Json; return envelope("interpro", input, rows(payload.results).map(compactInterpro), numeric(payload.count), dependencies, cursorFromUrl(payload.next));
}

let lastStringRequest = 0;
export async function getStringNetwork(input: z.infer<typeof stringNetworkInput>, dependencies: ScientificDependencies = {}) {
  if (!dependencies.fetch) { const wait = lastStringRequest + 1_000 - Date.now(); if (wait > 0) await (dependencies.sleep ?? delay)(wait); lastStringRequest = Date.now(); }
  const url = new URL("https://version-12-0.string-db.org/api/json/network"); url.searchParams.set("identifiers", input.identifiers.join("\r")); url.searchParams.set("species", String(input.species)); url.searchParams.set("required_score", String(input.required_score)); url.searchParams.set("network_type", input.network_type); url.searchParams.set("add_nodes", String(input.add_nodes)); url.searchParams.set("caller_identity", "pi-science");
  const payload = await getJson("protein_annotation", url, dependencies); return envelope("string-db-v12", input, Array.isArray(payload) ? payload as Json[] : [], null, dependencies);
}

export async function searchGeoDatasets(input: z.infer<typeof geoSearchInput>, dependencies: ScientificDependencies = {}) {
  const search = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"); search.searchParams.set("db", "gds"); search.searchParams.set("retmode", "json"); search.searchParams.set("term", input.query); search.searchParams.set("retmax", String(input.limit)); search.searchParams.set("retstart", String(input.offset)); search.searchParams.set("sort", input.sort_by === "date" ? "PDAT" : "relevance"); addNcbiIdentity(search);
  const found = await getJson("omics_archives", search, dependencies) as Json; const searchResult = object(found.esearchresult); const ids = Array.isArray(searchResult.idlist) ? searchResult.idlist.map(String) : [];
  let records: Json[] = [];
  if (ids.length) { const summary = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"); summary.searchParams.set("db", "gds"); summary.searchParams.set("retmode", "json"); summary.searchParams.set("id", ids.join(",")); addNcbiIdentity(summary); const data = await getJson("omics_archives", summary, dependencies) as Json; const result = object(data.result); records = ids.map((id) => ({ geo_uid: id, ...object(result[id]) })); }
  return envelope("ncbi-geo", input, records, numeric(searchResult.count), dependencies);
}

export async function searchPrideProjects(input: z.infer<typeof prideSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.ebi.ac.uk/pride/ws/archive/v2/search/projects"); url.searchParams.set("keyword", input.keyword); url.searchParams.set("page", String(input.page)); url.searchParams.set("pageSize", String(input.page_size)); const payload = await getJson("omics_archives", url, dependencies);
  return envelope("pride-archive", input, Array.isArray(payload) ? (payload as Json[]).map(compactPride) : [], null, dependencies);
}

export async function searchMgnifyStudies(input: z.infer<typeof mgnifySearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.ebi.ac.uk/metagenomics/api/v2/studies/"); url.searchParams.set("search", input.query); url.searchParams.set("page", String(input.page)); url.searchParams.set("page_size", String(input.page_size)); const payload = await getJson("omics_archives", url, dependencies) as Json;
  return envelope("mgnify", input, rows(payload.items), numeric(payload.count), dependencies);
}

const pubchemProperties = "Title,MolecularFormula,MolecularWeight,CanonicalSMILES,IsomericSMILES,InChI,InChIKey,IUPACName,XLogP,ExactMass,MonoisotopicMass,TPSA,Complexity,HBondDonorCount,HBondAcceptorCount,RotatableBondCount";
export async function searchPubchemCompounds(input: z.infer<typeof pubchemSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(input.name)}/property/${pubchemProperties}/JSON`); url.searchParams.set("MaxRecords", String(input.max_records)); const payload = await getJson("chemistry", url, dependencies) as Json; const records = rows(object(payload.PropertyTable).Properties);
  return envelope("pubchem", input, records.slice(0, input.max_records), records.length, dependencies);
}

export async function getPubchemCompound(input: z.infer<typeof pubchemCompoundInput>, dependencies: ScientificDependencies = {}) {
  const propertiesUrl = new URL(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${input.cid}/property/${pubchemProperties}/JSON`); const properties = await getJson("chemistry", propertiesUrl, dependencies) as Json; const record = rows(object(properties.PropertyTable).Properties)[0] ?? {};
  if (input.synonym_limit > 0) { const synonymsUrl = new URL(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${input.cid}/synonyms/JSON`); const synonyms = await getJson("chemistry", synonymsUrl, dependencies) as Json; record.synonyms = rows(object(synonyms.InformationList).Information)[0]?.Synonym instanceof Array ? (rows(object(synonyms.InformationList).Information)[0]!.Synonym as unknown[]).slice(0, input.synonym_limit) : []; }
  return singleEnvelope("pubchem", input, record, dependencies);
}

export async function searchChebiEntities(input: z.infer<typeof chebiSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.ebi.ac.uk/chebi/backend/api/public/es_search/"); url.searchParams.set("term", input.query); url.searchParams.set("page", String(input.page)); url.searchParams.set("size", String(input.page_size)); const payload = await getJson("chemistry", url, dependencies) as Json;
  return envelope("chebi", input, rows(payload.results).map((item) => object(item._source)), numeric(payload.total), dependencies);
}

export async function searchEncodeRecords(input: z.infer<typeof encodeSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.encodeproject.org/search/"); url.searchParams.set("type", input.record_type); url.searchParams.set("searchTerm", input.query); url.searchParams.set("status", input.status); url.searchParams.set("limit", String(input.limit)); url.searchParams.set("format", "json"); url.searchParams.set("frame", "object"); const payload = await getJson("regulation", url, dependencies) as Json;
  const records = rows(payload["@graph"]).map(compactEncode); return envelope("encode", input, records, numeric(payload.total), dependencies);
}

export async function getEncodeRecord(input: z.infer<typeof encodeRecordInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.encodeproject.org/search/"); url.searchParams.set("searchTerm", input.accession); url.searchParams.set("limit", "10"); url.searchParams.set("format", "json"); url.searchParams.set("frame", "object"); const payload = await getJson("regulation", url, dependencies) as Json; const record = rows(payload["@graph"]).find((item) => item.accession === input.accession);
  if (!record) throw new Error(`ENCODE has no public record for ${input.accession}`);
  return singleEnvelope("encode", input, record, dependencies);
}

export async function searchJasparMatrices(input: z.infer<typeof jasparSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://jaspar.elixir.no/api/v1/matrix/"); url.searchParams.set("search", input.query); if (input.collection) url.searchParams.set("collection", input.collection); if (input.tax_id?.length) url.searchParams.set("tax_id", input.tax_id.join(",")); url.searchParams.set("page", String(input.page)); url.searchParams.set("page_size", String(input.page_size)); url.searchParams.set("order", input.order); const payload = await getJson("regulation", url, dependencies) as Json;
  return envelope("jaspar", input, rows(payload.results), numeric(payload.count), dependencies, cursorFromUrl(payload.next));
}

// The primary Ensembl hostname can redirect to a release archive during site
// transitions, while the US mirror rejects non-browser clients. The official
// Asia mirror provides the same martservice without either behaviour.
const biomartBase = "https://asia.ensembl.org/biomart/martservice";
export async function listBiomartDatasets(input: z.infer<typeof biomartDatasetsInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(biomartBase); url.searchParams.set("type", "datasets"); url.searchParams.set("mart", input.mart); const text = await requestText("biomart", url, dependencies, { headers: { accept: "text/plain" } }); const records = text.trim().split(/\r?\n/).filter(Boolean).map((line) => { const values = line.split("\t"); return { type: values[0], dataset: values[1], display_name: values[2], assembly: values[4], date: values[6], virtual_schema: values[7] }; }).filter((item) => input.include_archived || !String(item.display_name ?? "").toLowerCase().includes("archive"));
  return envelope("ensembl-biomart", input, records, records.length, dependencies);
}

export async function queryBiomart(input: z.infer<typeof biomartQueryInput>, dependencies: ScientificDependencies = {}) {
  const filters = Object.entries(input.filters).map(([name, value]) => `<Filter name="${xml(name)}" value="${xml(Array.isArray(value) ? value.join(",") : String(value))}"/>`).join(""); const attributes = input.attributes.map((name) => `<Attribute name="${xml(name)}"/>`).join(""); const queryXml = `<?xml version="1.0" encoding="UTF-8"?><Query virtualSchemaName="default" formatter="TSV" header="1" uniqueRows="${input.unique_rows ? 1 : 0}" count="" datasetConfigVersion="0.6" limit="${input.limit}"><Dataset name="${xml(input.dataset)}" interface="default">${filters}${attributes}</Dataset></Query>`;
  const url = new URL(biomartBase); url.searchParams.set("query", queryXml); const text = await requestText("biomart", url, dependencies, { headers: { accept: "text/plain" }, signal: AbortSignal.timeout(45_000) }); if (/^Query ERROR/i.test(text)) throw new Error(text.trim().slice(0, 500)); const lines = text.trim().split(/\r?\n/).filter(Boolean); const headers = lines.shift()?.split("\t") ?? input.attributes; const records = lines.slice(0, input.limit).map((line) => Object.fromEntries(line.split("\t").map((value, index) => [headers[index] ?? input.attributes[index] ?? String(index), value])));
  return envelope("ensembl-biomart", { ...input, filters: Object.keys(input.filters) }, records, records.length, dependencies);
}

export async function searchOpenFdaLabels(input: z.infer<typeof openFdaLabelSearchInput>, dependencies: ScientificDependencies = {}) {
  const field = input.field === "indications_and_usage" ? input.field : `openfda.${input.field}`; const url = new URL("https://api.fda.gov/drug/label.json"); url.searchParams.set("search", `${field}:\"${openFdaTerm(input.query)}\"`); url.searchParams.set("limit", String(input.limit)); url.searchParams.set("skip", String(input.skip)); addOpenFdaKey(url); const payload = await getJson("drug_regulatory", url, dependencies) as Json;
  return envelope("openfda-label", input, rows(payload.results).map(compactLabel), numeric(object(object(payload.meta).results).total), dependencies);
}

export async function getOpenFdaLabel(input: z.infer<typeof openFdaLabelInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://api.fda.gov/drug/label.json"); url.searchParams.set("search", `set_id:\"${openFdaTerm(input.set_id)}\"`); url.searchParams.set("limit", "1"); addOpenFdaKey(url); const payload = await getJson("drug_regulatory", url, dependencies) as Json; const record = rows(payload.results)[0]; if (!record) throw new Error(`openFDA has no label for set_id ${input.set_id}`); return singleEnvelope("openfda-label", input, compactLabel(record), dependencies);
}

export async function searchDrugsFda(input: z.infer<typeof drugsFdaSearchInput>, dependencies: ScientificDependencies = {}) {
  const fields = { active_ingredient: "products.active_ingredients.name", sponsor_name: "sponsor_name", application_number: "application_number" }; const url = new URL("https://api.fda.gov/drug/drugsfda.json"); url.searchParams.set("search", `${fields[input.field]}:\"${openFdaTerm(input.query)}\"`); url.searchParams.set("limit", String(input.limit)); url.searchParams.set("skip", String(input.skip)); addOpenFdaKey(url); const payload = await getJson("drug_regulatory", url, dependencies) as Json;
  return envelope("drugs-at-fda", input, rows(payload.results).map(compactDrugsFda), numeric(object(object(payload.meta).results).total), dependencies);
}

export async function searchGwasStudies(input: z.infer<typeof gwasStudiesInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.ebi.ac.uk/gwas/rest/api/v2/studies"); addDefined(url, input, ["disease_trait", "efo_trait", "pubmed_id", "accession_id"]); url.searchParams.set("page", String(input.page)); url.searchParams.set("size", String(input.page_size)); const payload = await requestJson("human_genetics", url, dependencies, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(45_000) }) as Json;
  return gwasEnvelope("studies", input, payload, dependencies);
}

export async function searchGwasAssociations(input: z.infer<typeof gwasAssociationsInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.ebi.ac.uk/gwas/rest/api/v2/associations"); addDefined(url, input, ["efo_trait", "rs_id", "mapped_gene", "accession_id"]); url.searchParams.set("page", String(input.page)); url.searchParams.set("size", String(input.page_size)); const payload = await requestJson("human_genetics", url, dependencies, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(45_000) }) as Json;
  return gwasEnvelope("associations", input, payload, dependencies);
}

export async function getGwasStudy(input: z.infer<typeof gwasStudyInput>, dependencies: ScientificDependencies = {}) {
  // The v2 detail endpoint is currently much slower than the equivalent
  // stable record endpoint; both expose the same curated study accession.
  const url = new URL(`https://www.ebi.ac.uk/gwas/rest/api/studies/${input.accession_id}`); return singleEnvelope("gwas-catalog", input, await requestJson("human_genetics", url, dependencies, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25_000) }) as Json, dependencies);
}

function compactInterpro(item: Json) { const metadata = object(item.metadata); return { accession: metadata.accession, name: metadata.name, source_database: metadata.source_database, type: metadata.type, integrated: metadata.integrated, member_databases: metadata.member_databases, go_terms: metadata.go_terms, proteins: item.proteins }; }
function compactPride(item: Json) { return { accession: item.accession, title: item.title, project_description: item.projectDescription, keywords: item.keywords, species: item.species, tissues: item.tissues, diseases: item.diseases, instruments: item.instruments, submission_date: item.submissionDate, publication_date: item.publicationDate, doi: item.doi, pubmed_id: item.pubmedID }; }
function compactEncode(item: Json) { return { accession: item.accession, type: item["@type"], status: item.status, title: item.title, description: item.description, assay_title: item.assay_title, biosample_summary: item.biosample_summary, assembly: item.assembly, target: item.target, date_released: item.date_released, url: item["@id"] ? `https://www.encodeproject.org${item["@id"]}` : null }; }
function compactLabel(item: Json) { const openfda = object(item.openfda); return { set_id: item.set_id, id: item.id, effective_time: item.effective_time, version: item.version, generic_name: openfda.generic_name, brand_name: openfda.brand_name, manufacturer_name: openfda.manufacturer_name, product_ndc: openfda.product_ndc, route: openfda.route, substance_name: openfda.substance_name, indications_and_usage: firstText(item.indications_and_usage), boxed_warning: firstText(item.boxed_warning), warnings: firstText(item.warnings), adverse_reactions: firstText(item.adverse_reactions) }; }
function compactDrugsFda(item: Json) { return { application_number: item.application_number, sponsor_name: item.sponsor_name, openfda: item.openfda, products: item.products, submissions: Array.isArray(item.submissions) ? item.submissions.slice(0, 20) : [] }; }
function gwasEnvelope(kind: string, input: Json, payload: Json, dependencies: ScientificDependencies) { const embedded = object(payload._embedded); const pageInfo = object(payload.page); return envelope("gwas-catalog", input, rows(embedded[kind]), numeric(pageInfo.totalElements), dependencies, object(object(payload._links).next).href); }
function rows(value: unknown): Json[] { return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item && typeof item === "object" && !Array.isArray(item))) : []; }
function cursorFromUrl(value: unknown): string | undefined { if (typeof value !== "string") return undefined; try { return new URL(value).searchParams.get("cursor") ?? undefined; } catch { return undefined; } }
function firstText(value: unknown): unknown { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
function addNcbiIdentity(url: URL) { url.searchParams.set("tool", "pi_science"); const email = process.env.PI_SCIENCE_CONTACT_EMAIL?.trim(); if (email) url.searchParams.set("email", email); const key = process.env.NCBI_API_KEY?.trim(); if (key) url.searchParams.set("api_key", key); }
function addOpenFdaKey(url: URL) { const key = process.env.OPENFDA_API_KEY?.trim(); if (key) url.searchParams.set("api_key", key); }
function openFdaTerm(value: string) { return value.replace(/[\\"]/g, " ").replace(/\s+/g, " ").trim(); }
function addDefined(url: URL, input: Json, keys: string[]) { for (const key of keys) if (input[key] !== undefined) url.searchParams.set(key, String(input[key])); }
function xml(value: string) { return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function delay(milliseconds: number) { return new Promise<void>((resolve) => setTimeout(resolve, milliseconds)); }
