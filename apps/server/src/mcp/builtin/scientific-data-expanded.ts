import { z } from "zod";
import {
  envelope, getJson, numeric, object, requestJson, requestText, singleEnvelope,
  type ScientificDependencies,
} from "./scientific-data.js";

const query = z.string().trim().min(1).max(1_000);
const limit = z.number().int().min(1).max(100).default(20);
const offset = z.number().int().min(0).max(10_000).default(0);
const ucscName = z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}$/);
const uniprot = z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{4,19}$/i).transform((value) => value.toUpperCase());

export const emdbSearchInput = z.strictObject({ query, rows: limit, page: z.number().int().min(1).max(10_000).default(1) });
export const emdbEntryInput = z.strictObject({ emdb_id: z.string().trim().regex(/^(?:EMD-)?\d{4,6}$/i).transform((value) => `EMD-${value.replace(/^EMD-/i, "")}`) });
export const intactSearchInput = z.strictObject({ query, minimum_mi_score: z.number().min(0).max(1).default(0), maximum_mi_score: z.number().min(0).max(1).default(1), page: z.number().int().min(0).max(10_000).default(0), page_size: z.number().int().min(1).max(100).default(20), species: z.string().trim().min(1).max(100).optional() }).refine((value) => value.minimum_mi_score <= value.maximum_mi_score, { message: "minimum_mi_score must not exceed maximum_mi_score" });
export const complexPortalSearchInput = z.strictObject({ query, limit, offset, species: z.string().trim().min(1).max(100).optional() });

export const arrayExpressSearchInput = z.strictObject({ query, organism: z.string().trim().min(1).max(200).optional(), study_type: z.string().trim().min(1).max(100).optional(), technology: z.string().trim().min(1).max(100).optional(), page: z.number().int().min(1).max(10_000).default(1), page_size: z.number().int().min(1).max(100).default(20), sort_order: z.enum(["ascending", "descending"]).default("descending") });
export const arrayExpressStudyInput = z.strictObject({ accession: z.string().trim().regex(/^E-[A-Z0-9]+-\d+$/i).transform((value) => value.toUpperCase()) });
export const metabolightsListInput = z.strictObject({ query: z.string().trim().max(200).optional(), limit, offset });
export const metabolightsStudyInput = z.strictObject({ accession: z.string().trim().regex(/^MTBLS\d+$/i).transform((value) => value.toUpperCase()) });

export const bindingDbLigandsInput = z.strictObject({ uniprot_accession: uniprot, cutoff_nm: z.number().int().min(1).max(10_000_000).default(10_000), max_records: z.number().int().min(1).max(500).default(100) });
export const bindingDbTargetsInput = z.strictObject({ smiles: z.string().trim().min(1).max(2_000), similarity: z.number().min(0.5).max(1).default(0.85), max_records: z.number().int().min(1).max(500).default(100) });
export const rheaSearchInput = z.strictObject({ query, search_field: z.enum(["text", "chebi", "ec"]).default("text"), limit });
export const rheaEntryInput = z.strictObject({ rhea_id: z.union([z.number().int().positive(), z.string().trim().regex(/^(?:RHEA:)?\d+$/i)]).transform((value) => `RHEA:${String(value).replace(/^RHEA:/i, "")}`) });
export const humanProteinAtlasInput = z.strictObject({ ensembl_gene_id: z.string().trim().regex(/^ENSG\d{11}$/i).transform((value) => value.toUpperCase()), include_full_record: z.boolean().default(false) });

export const unibindSearchInput = z.strictObject({ tf_name: z.string().trim().min(1).max(100).optional(), organism: z.string().trim().min(1).max(100).optional(), biological_condition: z.string().trim().min(1).max(200).optional(), page: z.number().int().min(1).max(10_000).default(1), page_size: z.number().int().min(1).max(100).default(20) }).refine((value) => Boolean(value.tf_name || value.organism || value.biological_condition), { message: "Provide at least one UniBind filter" });
export const unibindDatasetInput = z.strictObject({ dataset_id: z.string().trim().regex(/^[A-Za-z0-9_.-]{3,200}$/) });
export const ucscTracksInput = z.strictObject({ genome: ucscName.default("hg38"), query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(500).default(100) });
export const ucscTrackDataInput = z.strictObject({ genome: ucscName.default("hg38"), track: ucscName, chromosome: z.string().trim().regex(/^chr[A-Za-z0-9_.-]+$/), start: z.number().int().min(0), end: z.number().int().positive(), max_items: z.number().int().min(1).max(10_000).default(1_000) }).refine((value) => value.start < value.end && value.end - value.start <= 5_000_000, { message: "Region must be positive and no longer than 5,000,000 bases" });

export const cellGuideMarkersInput = z.strictObject({ cell_ontology_id: z.string().trim().regex(/^CL:\d{7}$/i).transform((value) => value.toUpperCase()), marker_type: z.enum(["computational", "canonical"]).default("computational"), limit: z.number().int().min(1).max(100).default(20) });
export const cellGuideRelatedInput = z.strictObject({ cell_ontology_id: z.string().trim().regex(/^CL:\d{7}$/i).transform((value) => value.toUpperCase()) });

export const phewasSearchInput = z.strictObject({ query, limit: z.number().int().min(1).max(100).default(20) });
export const phewasVariantInput = z.strictObject({ variant: z.string().trim().regex(/^(?:chr)?[0-9XYM]+[-_:]\d+[-_:][ACGT]+[-_:][ACGT]+$/i).transform((value) => value.replace(/^chr/i, "").replace(/[_:]/g, "-")), limit: z.number().int().min(1).max(500).default(100) });

export const ontologyTermInput = z.strictObject({ ontology: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]*$/), term_id: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_.-]*:\d+$/), include_children: z.boolean().default(false), children_limit: z.number().int().min(1).max(100).default(20) });
export const quickGoAnnotationsInput = z.strictObject({ gene_product_id: z.string().trim().regex(/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/).default("UniProtKB:P04637"), aspect: z.enum(["biological_process", "molecular_function", "cellular_component"]).optional(), limit, page: z.number().int().min(1).max(10_000).default(1) });

export const biomartSchemaInput = z.strictObject({ dataset: z.string().trim().regex(/^[A-Za-z0-9_]{1,100}$/), kind: z.enum(["attributes", "filters"]) });
export const drugsFdaApplicationInput = z.strictObject({ application_number: z.string().trim().regex(/^(?:NDA|ANDA|BLA)\d{6}$/i).transform((value) => value.toUpperCase()) });

export const openTargetsDiseaseInput = z.strictObject({ disease_id: z.string().trim().regex(/^(?:EFO|MONDO|Orphanet|HP|OTAR)_?\d+$/i) });
export const openTargetsDrugInput = z.strictObject({ chembl_id: z.string().trim().regex(/^CHEMBL\d+$/i).transform((value) => value.toUpperCase()) });
export const chemblMechanismInput = z.strictObject({ molecule_chembl_id: z.string().trim().regex(/^CHEMBL\d+$/i).transform((value) => value.toUpperCase()), limit, offset });

type Json = Record<string, unknown>;

export async function searchEmdbEntries(input: z.infer<typeof emdbSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://www.ebi.ac.uk/emdb/api/search/${encodeURIComponent(input.query)}`); url.searchParams.set("rows", String(input.rows)); url.searchParams.set("page", String(input.page));
  const payload = await getJson("structures", url, dependencies); const records = rows(payload).map(compactEmdb);
  return envelope("emdb", input, records, null, dependencies);
}
export async function getEmdbEntry(input: z.infer<typeof emdbEntryInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://www.ebi.ac.uk/emdb/api/entry/${input.emdb_id}`); return singleEnvelope("emdb", input, compactEmdb(await getJson("structures", url, dependencies) as Json), dependencies);
}
export async function searchIntactInteractions(input: z.infer<typeof intactSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.ebi.ac.uk/intact/ws/interaction/findInteractionWithFacet"); addDefined(url, { query: input.query, minMIScore: input.minimum_mi_score, maxMIScore: input.maximum_mi_score, pageSize: input.page_size, page: input.page, interactorSpeciesFilter: input.species });
  const payload = await requestJson("structures", url, dependencies, { method: "POST", headers: { accept: "application/json" } }) as Json; const data = object(payload.data);
  return envelope("intact", input, rows(data.content).map(compactIntact), numeric(data.totalElements), dependencies, data.last === false ? input.page + 1 : undefined);
}
export async function searchComplexPortal(input: z.infer<typeof complexPortalSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://www.ebi.ac.uk/intact/complex-ws/search/${encodeURIComponent(input.query)}`); addDefined(url, { format: "json", first: input.offset, number: input.limit, filters: input.species ? `species_f:(\"${safeFilter(input.species)}\")` : undefined }); const payload = await getJson("structures", url, dependencies) as Json;
  return envelope("complex-portal", input, rows(payload.elements), numeric(payload.totalNumberOfResults), dependencies);
}

export async function searchArrayExpress(input: z.infer<typeof arrayExpressSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.ebi.ac.uk/biostudies/api/v1/arrayexpress/search"); addDefined(url, { query: input.query, "facet.organism": input.organism?.toLowerCase(), "facet.study_type": input.study_type?.toLowerCase(), "facet.technology": input.technology?.toLowerCase(), page: input.page, pageSize: input.page_size, sortBy: "release_date", sortOrder: input.sort_order }); const payload = await getJson("omics_archives", url, dependencies) as Json;
  return envelope("arrayexpress-biostudies", input, rows(payload.hits), numeric(payload.totalHits), dependencies, Number(payload.page ?? input.page) * Number(payload.pageSize ?? input.page_size) < Number(payload.totalHits ?? 0) ? input.page + 1 : undefined);
}
export async function getArrayExpressStudy(input: z.infer<typeof arrayExpressStudyInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://www.ebi.ac.uk/biostudies/api/v1/studies/${input.accession}`); return singleEnvelope("arrayexpress-biostudies", input, await getJson("omics_archives", url, dependencies) as Json, dependencies);
}
export async function listMetabolightsStudies(input: z.infer<typeof metabolightsListInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.ebi.ac.uk/metabolights/ws/studies"); const payload = await getJson("omics_archives", url, dependencies) as Json; const all = (Array.isArray(payload.content) ? payload.content.map(String) : []).filter((id) => !input.query || id.toLowerCase().includes(input.query.toLowerCase())); const records = all.slice(input.offset, input.offset + input.limit).map((accession) => ({ accession, url: `https://www.ebi.ac.uk/metabolights/${accession}` }));
  return envelope("metabolights", input, records, all.length, dependencies);
}
export async function getMetabolightsStudy(input: z.infer<typeof metabolightsStudyInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://www.ebi.ac.uk/metabolights/ws/studies/public/study/${input.accession}`); const payload = await getJson("omics_archives", url, dependencies) as Json; return singleEnvelope("metabolights", input, compactMetabolights(payload), dependencies);
}

export async function getBindingDbLigands(input: z.infer<typeof bindingDbLigandsInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://bindingdb.org/rest/getLigandsByUniprots"); addDefined(url, { uniprot: input.uniprot_accession, cutoff: input.cutoff_nm, code: 0, response: "application/json" }); const payload = unwrapOne(await getJson("chemistry", url, dependencies) as Json); const all = rows(payload.affinities);
  return envelope("bindingdb", input, all.slice(0, input.max_records), all.length, dependencies, undefined, all.length > input.max_records ? ["Results were truncated by max_records."] : []);
}
export async function getBindingDbTargets(input: z.infer<typeof bindingDbTargetsInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://bindingdb.org/rest/getTargetByCompound"); addDefined(url, { smiles: input.smiles, cutoff: input.similarity, response: "application/json" }); const payload = unwrapOne(await getJson("chemistry", url, dependencies) as Json); const all = rows(payload["bdb.affinities"]);
  return envelope("bindingdb", input, all.slice(0, input.max_records), numeric(payload["bdb.hit"]) ?? all.length, dependencies, undefined, all.length > input.max_records ? ["Results were truncated by max_records."] : []);
}
export async function searchRheaReactions(input: z.infer<typeof rheaSearchInput>, dependencies: ScientificDependencies = {}) {
  const where = rheaWhere(input); const sparql = `PREFIX rh: <http://rdf.rhea-db.org/> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> SELECT DISTINCT ?rhea ?equation WHERE { ?rhea rh:equation ?equation . ${where} } ORDER BY ?rhea LIMIT ${input.limit}`; const records = await rheaSelect(sparql, dependencies);
  return envelope("rhea", input, records.map(compactSparql), null, dependencies);
}
export async function getRheaReaction(input: z.infer<typeof rheaEntryInput>, dependencies: ScientificDependencies = {}) {
  const id = input.rhea_id.replace("RHEA:", ""); const sparql = `PREFIX rh: <http://rdf.rhea-db.org/> SELECT ?equation ?status ?ec WHERE { BIND(<http://rdf.rhea-db.org/${id}> AS ?rhea) ?rhea rh:equation ?equation . OPTIONAL { ?rhea rh:status ?status } OPTIONAL { ?rhea rh:ec ?ec } }`;
  return singleEnvelope("rhea", input, { rhea_id: input.rhea_id, rows: (await rheaSelect(sparql, dependencies)).map(compactSparql) }, dependencies);
}
export async function getHumanProteinAtlasGene(input: z.infer<typeof humanProteinAtlasInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://www.proteinatlas.org/${input.ensembl_gene_id}.json`); const payload = await getJson("protein_annotation", url, dependencies) as Json; return singleEnvelope("human-protein-atlas", input, input.include_full_record ? payload : compactHpa(payload), dependencies);
}

export async function searchUnibindDatasets(input: z.infer<typeof unibindSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://unibind.uio.no/api/v1/datasets/"); addDefined(url, { tf_name: input.tf_name, organism: input.organism, biological_condition: input.biological_condition, page: input.page, page_size: input.page_size }); const payload = await getJson("regulation", url, dependencies) as Json;
  return envelope("unibind", input, rows(payload.results), numeric(payload.count), dependencies, payload.next);
}
export async function getUnibindDataset(input: z.infer<typeof unibindDatasetInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://unibind.uio.no/api/v1/datasets/${input.dataset_id}/`); return singleEnvelope("unibind", input, await getJson("regulation", url, dependencies) as Json, dependencies);
}
export async function listUcscTracks(input: z.infer<typeof ucscTracksInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://api.genome.ucsc.edu/search"); addDefined(url, { genome: input.genome, search: input.query, categories: "trackDb" }); const payload = await getJson("genomes", url, dependencies) as Json; const all = rows(payload.positionMatches).flatMap((group) => rows(group.matches)); const records = all.slice(0, input.limit);
  return envelope("ucsc", input, records, all.length, dependencies, undefined, all.length > input.limit ? ["Track matches were truncated by limit."] : []);
}
export async function getUcscTrackData(input: z.infer<typeof ucscTrackDataInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://api.genome.ucsc.edu/getData/track"); addDefined(url, { genome: input.genome, track: input.track, chrom: input.chromosome, start: input.start, end: input.end, maxItemsOutput: input.max_items }); const payload = await getJson("genomes", url, dependencies) as Json; const records = rows(payload[input.track] ?? object(payload[input.chromosome])[input.track]); const warnings = payload.maxItemsLimit ? ["UCSC reported maxItemsLimit; narrow the interval for a complete result."] : [];
  return envelope("ucsc", input, records, numeric(payload.itemsReturned), dependencies, undefined, warnings);
}

export async function getCellGuideMarkers(input: z.infer<typeof cellGuideMarkersInput>, dependencies: ScientificDependencies = {}) {
  const snapshot = await cellGuideSnapshot(dependencies); const id = input.cell_ontology_id.replace(":", "_"); const url = new URL(`https://cellguide.cellxgene.cziscience.com/${snapshot}/${input.marker_type}_marker_genes/${id}.json`); const payload = await getJson("cellguide", url, dependencies); const records = rows(payload).sort((a, b) => numeric(b.marker_score)! - numeric(a.marker_score)!).slice(0, input.limit);
  return envelope("cellxgene-cellguide", { ...input, snapshot }, records, records.length, dependencies);
}
export async function getCellGuideSources(input: z.infer<typeof cellGuideRelatedInput>, dependencies: ScientificDependencies = {}) {
  const snapshot = await cellGuideSnapshot(dependencies); const id = input.cell_ontology_id.replace(":", "_"); const url = new URL(`https://cellguide.cellxgene.cziscience.com/${snapshot}/source_collections/${id}.json`); const payload = await getJson("cellguide", url, dependencies); return envelope("cellxgene-cellguide", { ...input, snapshot }, rows(payload), null, dependencies);
}
export async function getCellGuideTissues(input: z.infer<typeof cellGuideRelatedInput>, dependencies: ScientificDependencies = {}) {
  const snapshot = await cellGuideSnapshot(dependencies); const mapping = await getJson("cellguide", new URL(`https://cellguide.cellxgene.cziscience.com/${snapshot}/ontology_tree/NCBITaxon_9606/celltype_to_tissue_mapping.json`), dependencies) as Json; const metadata = await getJson("cellguide", new URL(`https://cellguide.cellxgene.cziscience.com/${snapshot}/tissue_metadata.json`), dependencies) as Json; const records = (Array.isArray(mapping[input.cell_ontology_id]) ? mapping[input.cell_ontology_id] as unknown[] : []).map((id) => ({ id, ...object(metadata[String(id)]) }));
  return envelope("cellxgene-cellguide", { ...input, snapshot }, records, records.length, dependencies);
}

export async function searchPhewas(input: z.infer<typeof phewasSearchInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://r12.finngen.fi/api/autocomplete"); url.searchParams.set("query", input.query); const payload = await getJson("human_genetics", url, dependencies); return envelope("finngen-r12", input, rows(payload).slice(0, input.limit), null, dependencies);
}
export async function getPhewasVariant(input: z.infer<typeof phewasVariantInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL(`https://r12.finngen.fi/api/variant/${input.variant}`); const payload = await getJson("human_genetics", url, dependencies) as Json; const records = rows(payload.results ?? payload.phenos).slice(0, input.limit); return envelope("finngen-r12", input, records, rows(payload.results ?? payload.phenos).length, dependencies);
}

export async function getOntologyTerm(input: z.infer<typeof ontologyTermInput>, dependencies: ScientificDependencies = {}) {
  const iri = encodeURIComponent(encodeURIComponent(`http://purl.obolibrary.org/obo/${input.term_id.replace(":", "_")}`)); const url = new URL(`https://www.ebi.ac.uk/ols4/api/ontologies/${input.ontology.toLowerCase()}/terms/${iri}`); const term = await getJson("genes_ontologies", url, dependencies) as Json; if (!input.include_children) return singleEnvelope("ebi-ols", input, term, dependencies); const childrenUrl = new URL(`${url.toString()}/children`); childrenUrl.searchParams.set("size", String(input.children_limit)); const children = await getJson("genes_ontologies", childrenUrl, dependencies) as Json; return singleEnvelope("ebi-ols", input, { ...term, children: rows(object(children._embedded).terms) }, dependencies);
}
export async function getQuickGoAnnotations(input: z.infer<typeof quickGoAnnotationsInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.ebi.ac.uk/QuickGO/services/annotation/search"); addDefined(url, { geneProductId: input.gene_product_id, aspect: input.aspect ? { biological_process: "biological_process", molecular_function: "molecular_function", cellular_component: "cellular_component" }[input.aspect] : undefined, limit: input.limit, page: input.page }); const payload = await getJson("genes_ontologies", url, dependencies) as Json;
  const current = numeric(object(payload.pageInfo).current); const totalPages = numeric(object(payload.pageInfo).total);
  return envelope("quickgo", input, rows(payload.results), numeric(payload.numberOfHits), dependencies, current !== null && totalPages !== null && current < totalPages ? input.page + 1 : undefined);
}
export async function listBiomartSchema(input: z.infer<typeof biomartSchemaInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://asia.ensembl.org/biomart/martservice"); url.searchParams.set("type", input.kind); url.searchParams.set("dataset", input.dataset); const text = await requestText("biomart", url, dependencies, { headers: { accept: "text/plain" } }); const records = text.split(/\r?\n/).filter(Boolean).slice(0, 5_000).map((line) => { const [name, display_name, description, page, type] = line.split("\t"); return { name, display_name, description, page, type }; }); return envelope("ensembl-biomart", input, records, records.length, dependencies);
}
export async function getDrugsFdaApplication(input: z.infer<typeof drugsFdaApplicationInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://api.fda.gov/drug/drugsfda.json"); url.searchParams.set("search", `application_number:\"${input.application_number}\"`); url.searchParams.set("limit", "1"); addOpenFdaKey(url); const payload = await getJson("drug_regulatory", url, dependencies) as Json; const record = rows(payload.results)[0]; if (!record) throw new Error(`Drugs@FDA has no application ${input.application_number}`); return singleEnvelope("drugs-at-fda", input, record, dependencies);
}

export async function getOpenTargetsDisease(input: z.infer<typeof openTargetsDiseaseInput>, dependencies: ScientificDependencies = {}) {
  const graphql = `query Disease($id: String!) { disease(efoId: $id) { id name description therapeuticAreas { id name } associatedTargets(page: { index: 0, size: 50 }) { count rows { score target { id approvedSymbol approvedName } } } } }`; return openTargetsRecord("disease", input.disease_id, graphql, { id: input.disease_id }, input, dependencies);
}
export async function getOpenTargetsDrug(input: z.infer<typeof openTargetsDrugInput>, dependencies: ScientificDependencies = {}) {
  const graphql = `query Drug($id: String!) { drug(chemblId: $id) { id name description drugType maximumClinicalStage mechanismsOfAction { rows { actionType mechanismOfAction targets { id approvedSymbol approvedName } } } indications { count rows { disease { id name } maxClinicalStage } } } }`; return openTargetsRecord("drug", input.chembl_id, graphql, { id: input.chembl_id }, input, dependencies);
}
export async function getChemblMechanisms(input: z.infer<typeof chemblMechanismInput>, dependencies: ScientificDependencies = {}) {
  const url = new URL("https://www.ebi.ac.uk/chembl/api/data/mechanism.json"); addDefined(url, { molecule_chembl_id: input.molecule_chembl_id, limit: input.limit, offset: input.offset }); const payload = await getJson("chembl", url, dependencies) as Json; const meta = object(payload.page_meta); return envelope("chembl", input, rows(payload.mechanisms), numeric(meta.total_count), dependencies, meta.next);
}

function compactEmdb(item: Json): Json { const admin = object(item.admin); const map = object(item.map); const structure = object(item.structure_determination_list); return { emdb_id: item.emdb_id ?? admin.keywords, title: item.title, current_status: item.current_status, deposition_date: item.deposition_date, release_date: item.release_date, resolution: map.resolution, structure_determination: structure, sample: item.sample, crossreferences: item.crossreferences }; }
function compactIntact(item: Json): Json { return { interaction_ac: item.ac, binary_interaction_id: item.binaryInteractionId, id_a: item.idA, id_b: item.idB, molecule_a: item.moleculeA, molecule_b: item.moleculeB, species_a: item.speciesA, species_b: item.speciesB, interaction_type: item.type, detection_method: item.detectionMethod, mi_score: item.intactMiscore, negative: item.negative, pubmed_id: item.publicationPubmedIdentifier }; }
function compactMetabolights(payload: Json): Json { const content = object(payload.content); return { accession: content.studyIdentifier, title: content.title, description: content.studyDescription, status: content.studyStatus, organism: content.organism, assays: content.assays, factors: content.factors, publications: content.publications, contacts: content.contacts, derived_data: content.derivedData }; }
function compactHpa(item: Json): Json { const keep = ["Gene", "Gene synonym", "Ensembl", "Gene description", "Uniprot", "Chromosome", "Position", "Protein class", "Biological process", "Molecular function", "Disease involvement", "RNA tissue specificity", "RNA tissue distribution", "Subcellular location", "Prognostic p-value"] as const; return Object.fromEntries(keep.filter((key) => item[key] !== undefined).map((key) => [key, item[key]])); }
function compactSparql(row: Json): Json { return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, object(value).value ?? value])); }
function rows(value: unknown): Json[] { return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item && typeof item === "object" && !Array.isArray(item))) : []; }
function addDefined(url: URL, values: Json) { for (const [key, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(key, String(value)); }
function safeFilter(value: string) { return value.replace(/[\\"(),]/g, " ").replace(/\s+/g, " ").trim(); }
function unwrapOne(payload: Json): Json { const values = Object.values(payload); return values.length === 1 && values[0] && typeof values[0] === "object" && !Array.isArray(values[0]) ? values[0] as Json : payload; }
function sparqlString(value: string) { return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\t]/g, " "); }
function rheaWhere(input: z.infer<typeof rheaSearchInput>) { const value = sparqlString(input.query); if (input.search_field === "chebi") { const id = input.query.replace(/^CHEBI:/i, ""); if (!/^\d+$/.test(id)) throw new Error("ChEBI search requires CHEBI:<digits>"); return `?rhea rh:side/rh:contains/rh:compound <http://purl.obolibrary.org/obo/CHEBI_${id}> .`; } if (input.search_field === "ec") { if (!/^\d+(?:\.\d+|-){3}$/.test(input.query)) throw new Error("EC search requires an EC number such as 1.1.1.1"); return `?rhea rh:ec <http://purl.uniprot.org/enzyme/${value}> .`; } return `FILTER(CONTAINS(LCASE(STR(?equation)), LCASE(\"${value}\")))`; }
async function rheaSelect(sparql: string, dependencies: ScientificDependencies): Promise<Json[]> { const url = new URL("https://sparql.rhea-db.org/sparql"); const payload = await requestJson("chemistry", url, dependencies, { method: "POST", headers: { accept: "application/sparql-results+json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ query: sparql }).toString() }) as Json; return rows(object(object(payload.results)).bindings); }
async function cellGuideSnapshot(dependencies: ScientificDependencies) { const value = (await requestText("cellguide", new URL("https://cellguide.cellxgene.cziscience.com/latest_snapshot_identifier"), dependencies)).trim().replace(/^"|"$/g, ""); if (!/^\d+$/.test(value)) throw new Error("CellGuide returned an invalid snapshot identifier"); return value; }
async function openTargetsRecord(kind: string, id: string, graphql: string, variables: Json, input: Json, dependencies: ScientificDependencies) { const url = new URL("https://api.platform.opentargets.org/api/v4/graphql"); const payload = await requestJson("target_discovery", url, dependencies, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ query: graphql, variables }) }) as Json; const errors = rows(payload.errors); if (errors.length) throw new Error(`Open Targets GraphQL error: ${String(errors[0]!.message ?? "unknown error")}`); const record = object(object(payload.data)[kind]); if (!Object.keys(record).length) throw new Error(`Open Targets has no ${kind} for ${id}`); return singleEnvelope("open-targets", input, record, dependencies); }
function addOpenFdaKey(url: URL) { const key = process.env.OPENFDA_API_KEY?.trim(); if (key) url.searchParams.set("api_key", key); }
