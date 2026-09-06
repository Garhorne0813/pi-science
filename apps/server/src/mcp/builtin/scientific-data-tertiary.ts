import { z } from "zod";
import {
  envelope, getJson, numeric, object, requestJson, requestText, requestTextWithHeaders,
  singleEnvelope, type ScientificDependencies,
} from "./scientific-data.js";

const query = z.string().trim().min(1).max(1_000);
const pageSize = z.number().int().min(1).max(100).default(20);
const offset = z.number().int().min(0).max(10_000).default(0);
const uniprotAccession = z.string().trim().regex(/^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){2})(?:-\d+)?$/i).transform((value) => value.toUpperCase());
const nucleotideAccession = z.string().trim().regex(/^[A-Z]{1,6}_?[A-Z0-9]{1,12}(?:\.\d+)?$/i).transform((value) => value.toUpperCase());
const boundedText = z.number().int().min(1_000).max(200_000).default(50_000);

export const uniprotSearchInput = z.strictObject({
  query,
  organism_id: z.number().int().positive().optional(),
  reviewed: z.boolean().optional(),
  include_isoforms: z.boolean().default(false),
  size: z.number().int().min(1).max(500).default(25),
  cursor: z.string().trim().min(1).max(2_000).optional(),
  sort_by: z.enum(["relevance", "accession", "protein_name", "gene_name", "length"]).default("relevance"),
  sort_order: z.enum(["ascending", "descending"]).default("descending"),
});
export const uniprotEntryInput = z.strictObject({ accession: uniprotAccession, include_sequence: z.boolean().default(false) });
export const uniprotSequenceInput = z.strictObject({ accession: uniprotAccession, max_characters: boundedText });

export const genbankSearchInput = z.strictObject({
  query,
  organism: z.string().trim().min(1).max(200).optional(),
  date_from: z.string().regex(/^\d{4}(?:\/\d{2}(?:\/\d{2})?)?$/).optional(),
  date_to: z.string().regex(/^\d{4}(?:\/\d{2}(?:\/\d{2})?)?$/).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset,
  sort_by: z.enum(["relevance", "publication_date"]).default("relevance"),
}).superRefine((value, context) => {
  if (value.date_from && value.date_to && value.date_from > value.date_to) context.addIssue({ code: "custom", message: "date_from must not be after date_to" });
});
export const genbankSequenceInput = z.strictObject({
  accession: nucleotideAccession,
  format: z.enum(["fasta", "genbank"]).default("fasta"),
  sequence_start: z.number().int().positive().optional(),
  sequence_stop: z.number().int().positive().optional(),
  strand: z.enum(["forward", "reverse"]).default("forward"),
  max_characters: boundedText,
}).superRefine((value, context) => {
  if ((value.sequence_start == null) !== (value.sequence_stop == null)) context.addIssue({ code: "custom", message: "sequence_start and sequence_stop must be provided together" });
  if (value.sequence_start && value.sequence_stop && value.sequence_start > value.sequence_stop) context.addIssue({ code: "custom", message: "sequence_start must not be after sequence_stop" });
  if (value.sequence_start && value.sequence_stop && value.sequence_stop - value.sequence_start > 1_000_000) context.addIssue({ code: "custom", message: "requested interval must not exceed 1,000,001 bases" });
});
export const enaSequenceInput = z.strictObject({ accession: nucleotideAccession, max_characters: boundedText });

const openTargetsEntities = z.enum(["target", "disease", "drug", "variant", "study"]);
export const openTargetsSearchInput = z.strictObject({ query, entity_types: z.array(openTargetsEntities).min(1).max(5).optional(), page: z.number().int().min(0).max(10_000).default(0), page_size: z.number().int().min(1).max(100).default(20) });
export const openTargetsTargetInput = z.strictObject({ ensembl_gene_id: z.string().trim().regex(/^ENSG\d{11}$/i).transform((value) => value.toUpperCase()), association_page: z.number().int().min(0).max(10_000).default(0), association_page_size: z.number().int().min(1).max(100).default(20), include_indirect: z.boolean().default(false) });

const chemblId = z.string().trim().regex(/^CHEMBL\d+$/i).transform((value) => value.toUpperCase());
export const chemblMoleculeSearchInput = z.strictObject({ query, molecule_type: z.enum(["Small molecule", "Protein", "Antibody", "Oligosaccharide", "Oligonucleotide", "Cell", "Enzyme"]).optional(), minimum_phase: z.number().int().min(0).max(4).optional(), limit: pageSize, offset });
export const chemblTargetSearchInput = z.strictObject({ query, organism: z.string().trim().min(1).max(200).optional(), target_type: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9 /_-]{0,79}$/).optional(), limit: pageSize, offset });
export const chemblActivitySearchInput = z.strictObject({
  molecule_chembl_id: chemblId.optional(), target_chembl_id: chemblId.optional(),
  standard_type: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9 _/-]{0,49}$/).optional(),
  minimum_pchembl: z.number().min(0).max(20).optional(), maximum_pchembl: z.number().min(0).max(20).optional(),
  limit: pageSize, offset,
}).superRefine((value, context) => {
  if (!value.molecule_chembl_id && !value.target_chembl_id) context.addIssue({ code: "custom", message: "Provide molecule_chembl_id or target_chembl_id" });
  if (value.minimum_pchembl != null && value.maximum_pchembl != null && value.minimum_pchembl > value.maximum_pchembl) context.addIssue({ code: "custom", message: "minimum_pchembl must not exceed maximum_pchembl" });
});

type Json = Record<string, unknown>;

export async function searchUniprotProteins(input: z.infer<typeof uniprotSearchInput>, dependencies: ScientificDependencies = {}) {
  const filters = [input.query, input.organism_id && `organism_id:${input.organism_id}`, input.reviewed !== undefined && `reviewed:${input.reviewed}`].filter((value): value is string => Boolean(value));
  const url = new URL("https://rest.uniprot.org/uniprotkb/search"); url.searchParams.set("query", filters.map((value) => `(${value})`).join(" AND ")); url.searchParams.set("format", "json"); url.searchParams.set("size", String(input.size)); url.searchParams.set("includeIsoform", String(input.include_isoforms)); url.searchParams.set("fields", "accession,id,protein_name,gene_names,organism_name,organism_id,length,reviewed"); if (input.cursor) url.searchParams.set("cursor", input.cursor); if (input.sort_by !== "relevance") { const sort = { accession: "accession", protein_name: "protein_name", gene_name: "gene", length: "length" }[input.sort_by]; url.searchParams.set("sort", `${sort} ${input.sort_order === "ascending" ? "asc" : "desc"}`); }
  const response = await requestTextWithHeaders("protein_records", url, dependencies, { headers: { accept: "application/json" } }); const payload = JSON.parse(response.text) as Json;
  return envelope("uniprotkb", input, rows(payload.results).map((item) => compactUniprot(item)), numeric(response.headers.get("x-total-results")), dependencies, linkCursor(response.headers.get("link")));
}

export async function getUniprotEntry(input: z.infer<typeof uniprotEntryInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://rest.uniprot.org/uniprotkb/${input.accession}.json`); const record = compactUniprot(await getJson("protein_records", url, dependencies) as Json, input.include_sequence);
  return singleEnvelope("uniprotkb", input, record, dependencies);
}

export async function getUniprotSequence(input: z.infer<typeof uniprotSequenceInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://rest.uniprot.org/uniprotkb/${input.accession}.fasta`); const text = await requestText("protein_records", url, dependencies, { headers: { accept: "text/plain" } });
  return textEnvelope("uniprotkb", input, text, input.max_characters, dependencies);
}

export async function searchGenbankSequences(input: z.infer<typeof genbankSearchInput>, dependencies: ScientificDependencies = {}) {
  await paceNcbi(dependencies); const search = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"); const terms = [input.query, input.organism && `${input.organism}[Organism]`].filter(Boolean); search.searchParams.set("db", "nuccore"); search.searchParams.set("term", terms.join(" AND ")); search.searchParams.set("retmode", "json"); search.searchParams.set("retmax", String(input.limit)); search.searchParams.set("retstart", String(input.offset)); if (input.sort_by === "publication_date") search.searchParams.set("sort", "pub date"); if (input.date_from) search.searchParams.set("mindate", input.date_from); if (input.date_to) search.searchParams.set("maxdate", input.date_to); if (input.date_from || input.date_to) search.searchParams.set("datetype", "pdat"); addNcbiIdentity(search);
  const found = await getJson("nucleotide_archives", search, dependencies) as Json; const searchResult = object(found.esearchresult); const ids = Array.isArray(searchResult.idlist) ? searchResult.idlist.map(String) : [];
  let records: Json[] = [];
  if (ids.length) { await paceNcbi(dependencies); const summary = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"); summary.searchParams.set("db", "nuccore"); summary.searchParams.set("id", ids.join(",")); summary.searchParams.set("retmode", "json"); addNcbiIdentity(summary); const payload = await getJson("nucleotide_archives", summary, dependencies) as Json; const result = object(payload.result); records = ids.map((id) => compactGenbank(id, object(result[id]))); }
  return envelope("ncbi-genbank", input, records, numeric(searchResult.count), dependencies);
}

export async function getGenbankSequence(input: z.infer<typeof genbankSequenceInput>, dependencies: ScientificDependencies = {}) {
  await paceNcbi(dependencies); const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"); url.searchParams.set("db", "nuccore"); url.searchParams.set("id", input.accession); url.searchParams.set("rettype", input.format === "genbank" ? "gb" : "fasta"); url.searchParams.set("retmode", "text"); url.searchParams.set("strand", input.strand === "reverse" ? "2" : "1"); if (input.sequence_start) { url.searchParams.set("seq_start", String(input.sequence_start)); url.searchParams.set("seq_stop", String(input.sequence_stop)); } addNcbiIdentity(url); const text = await requestText("nucleotide_archives", url, dependencies, { headers: { accept: "text/plain" } });
  return textEnvelope("ncbi-genbank", input, text, input.max_characters, dependencies);
}

export async function getEnaSequence(input: z.infer<typeof enaSequenceInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://www.ebi.ac.uk/ena/browser/api/fasta/${input.accession}`); const text = await requestText("nucleotide_archives", url, dependencies, { headers: { accept: "text/plain" } });
  return textEnvelope("ena", input, text, input.max_characters, dependencies);
}

export async function searchOpenTargetsEntities(input: z.infer<typeof openTargetsSearchInput>, dependencies: ScientificDependencies = {}) {
  const payload = await openTargets(`query Search($query: String!, $entities: [String!], $page: Pagination!) { search(queryString: $query, entityNames: $entities, page: $page) { total hits { id name description entity } } }`, { query: input.query, entities: input.entity_types, page: { index: input.page, size: input.page_size } }, dependencies); const search = object(object(payload.data).search);
  return envelope("open-targets", input, rows(search.hits), numeric(search.total), dependencies);
}

export async function getOpenTargetsTarget(input: z.infer<typeof openTargetsTargetInput>, dependencies: ScientificDependencies = {}) {
  const payload = await openTargets(`query Target($id: String!, $page: Pagination!, $indirect: Boolean!) { target(ensemblId: $id) { id approvedSymbol approvedName biotype functionDescriptions tractability { label modality value } associatedDiseases(page: $page, enableIndirect: $indirect) { count rows { score disease { id name description } } } } }`, { id: input.ensembl_gene_id, page: { index: input.association_page, size: input.association_page_size }, indirect: input.include_indirect }, dependencies); const target = object(object(payload.data).target); if (!Object.keys(target).length) throw new Error(`Open Targets has no target for ${input.ensembl_gene_id}`);
  return singleEnvelope("open-targets", input, target, dependencies);
}

export async function searchChemblMolecules(input: z.infer<typeof chemblMoleculeSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.ebi.ac.uk/chembl/api/data/molecule/search.json"); url.searchParams.set("q", input.query); addPagination(url, input); if (input.molecule_type) url.searchParams.set("molecule_type", input.molecule_type); if (input.minimum_phase != null) url.searchParams.set("max_phase__gte", String(input.minimum_phase)); const payload = await getJson("chembl", url, dependencies) as Json;
  return chemblEnvelope("molecules", input, payload, dependencies, compactChemblMolecule);
}

export async function searchChemblTargets(input: z.infer<typeof chemblTargetSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.ebi.ac.uk/chembl/api/data/target/search.json"); url.searchParams.set("q", input.query); addPagination(url, input); if (input.organism) url.searchParams.set("organism__iexact", input.organism); if (input.target_type) url.searchParams.set("target_type__iexact", input.target_type); const payload = await getJson("chembl", url, dependencies) as Json;
  return chemblEnvelope("targets", input, payload, dependencies, compactChemblTarget);
}

export async function searchChemblActivities(input: z.infer<typeof chemblActivitySearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.ebi.ac.uk/chembl/api/data/activity.json"); addPagination(url, input); for (const key of ["molecule_chembl_id", "target_chembl_id", "standard_type"] as const) if (input[key]) url.searchParams.set(key, String(input[key])); if (input.minimum_pchembl != null) url.searchParams.set("pchembl_value__gte", String(input.minimum_pchembl)); if (input.maximum_pchembl != null) url.searchParams.set("pchembl_value__lte", String(input.maximum_pchembl)); const payload = await getJson("chembl", url, dependencies) as Json;
  return chemblEnvelope("activities", input, payload, dependencies, compactChemblActivity);
}

async function openTargets(graphql: string, variables: Json, dependencies: ScientificDependencies): Promise<Json> {
  const url = new URL("https://api.platform.opentargets.org/api/v4/graphql"); const payload = await requestJson("target_discovery", url, dependencies, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ query: graphql, variables }) }) as Json; const errors = Array.isArray(payload.errors) ? payload.errors : []; if (errors.length) throw new Error(`Open Targets GraphQL error: ${String(object(errors[0]).message ?? "unknown error")}`); return payload;
}

function compactUniprot(item: Json, includeSequence = false): Json { const description = object(item.proteinDescription); const recommended = object(object(description.recommendedName).fullName); const submitted = object(object(description.submissionNames instanceof Array ? description.submissionNames[0] : undefined).fullName); const sequence = object(item.sequence); return { accession: item.primaryAccession, entry_id: item.uniProtkbId, entry_type: item.entryType, protein_name: recommended.value ?? submitted.value, genes: rows(item.genes).map((gene) => object(gene.geneName).value).filter(Boolean), organism: object(item.organism), sequence: { length: sequence.length, mol_weight: sequence.molWeight, crc64: sequence.crc64, md5: sequence.md5, ...(includeSequence ? { value: sequence.value } : {}) }, functions: rows(item.comments).filter((comment) => comment.commentType === "FUNCTION").flatMap((comment) => rows(comment.texts).map((text) => text.value).filter(Boolean)) }; }
function compactGenbank(uid: string, item: Json): Json { return { uid, accession: item.caption, accession_version: item.accessionversion ?? object(item.oslt).value, title: item.title, organism: item.organism, tax_id: item.taxid, length: item.slen, molecule_type: item.moltype, biomolecule: item.biomol, topology: item.topology, source_database: item.sourcedb, create_date: item.createdate, update_date: item.updatedate, url: `https://www.ncbi.nlm.nih.gov/nuccore/${item.accessionversion ?? item.caption ?? uid}` }; }
function compactChemblMolecule(item: Json): Json { return { molecule_chembl_id: item.molecule_chembl_id, pref_name: item.pref_name, molecule_type: item.molecule_type, max_phase: item.max_phase, first_approval: item.first_approval, oral: item.oral, parenteral: item.parenteral, topical: item.topical, molecule_properties: item.molecule_properties, molecule_structures: item.molecule_structures }; }
function compactChemblTarget(item: Json): Json { return { target_chembl_id: item.target_chembl_id, pref_name: item.pref_name, target_type: item.target_type, organism: item.organism, tax_id: item.tax_id, target_components: item.target_components }; }
function compactChemblActivity(item: Json): Json { return { activity_id: item.activity_id, molecule_chembl_id: item.molecule_chembl_id, target_chembl_id: item.target_chembl_id, target_pref_name: item.target_pref_name, standard_type: item.standard_type, standard_relation: item.standard_relation, standard_value: item.standard_value, standard_units: item.standard_units, pchembl_value: item.pchembl_value, assay_chembl_id: item.assay_chembl_id, document_chembl_id: item.document_chembl_id }; }
function chemblEnvelope(kind: string, input: Json, payload: Json, dependencies: ScientificDependencies, compact: (item: Json) => Json) { const meta = object(payload.page_meta); return envelope("chembl", input, rows(payload[kind]).map(compact), numeric(meta.total_count), dependencies, meta.next); }
function textEnvelope(source: string, input: Json, text: string, maximum: number, dependencies: ScientificDependencies) { return singleEnvelope(source, input, { text: text.slice(0, maximum), truncated: text.length > maximum, total_characters: text.length }, dependencies); }
function rows(value: unknown): Json[] { return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item && typeof item === "object" && !Array.isArray(item))) : []; }
function addPagination(url: URL, input: { limit: number; offset: number }) { url.searchParams.set("limit", String(input.limit)); url.searchParams.set("offset", String(input.offset)); }
function linkCursor(link: string | null): string | undefined { if (!link) return undefined; const next = link.split(",").find((item) => /rel="next"/.test(item)); const match = next?.match(/<([^>]+)>/); if (!match) return undefined; try { return new URL(match[1]!).searchParams.get("cursor") ?? undefined; } catch { return undefined; } }
function addNcbiIdentity(url: URL) { url.searchParams.set("tool", "pi_science"); const email = process.env.PI_SCIENCE_CONTACT_EMAIL?.trim(); if (email) url.searchParams.set("email", email); const key = process.env.NCBI_API_KEY?.trim(); if (key) url.searchParams.set("api_key", key); }
let lastNcbiRequest = 0;
async function paceNcbi(dependencies: ScientificDependencies) { if (dependencies.fetch) return; const wait = lastNcbiRequest + (process.env.NCBI_API_KEY ? 110 : 350) - Date.now(); if (wait > 0) await (dependencies.sleep ?? delay)(wait); lastNcbiRequest = Date.now(); }
function delay(milliseconds: number) { return new Promise<void>((resolve) => setTimeout(resolve, milliseconds)); }
