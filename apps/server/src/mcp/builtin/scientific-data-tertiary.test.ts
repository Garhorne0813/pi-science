import { describe, expect, it } from "vitest";
import type { ScientificDependencies } from "./scientific-data.js";
import {
  chemblActivitySearchInput, genbankSequenceInput, getEnaSequence, getGenbankSequence,
  getOpenTargetsTarget, getUniprotEntry, openTargetsSearchInput, searchChemblActivities,
  searchChemblMolecules, searchChemblTargets, searchGenbankSequences, searchOpenTargetsEntities,
  searchUniprotProteins, uniprotSearchInput,
} from "./scientific-data-tertiary.js";

const now = () => new Date("2026-09-06T00:00:00.000Z");
function responses(...values: Array<unknown | { body: unknown; headers?: Record<string, string> }>): ScientificDependencies & { requests: Array<{ url: URL; init?: RequestInit }> } {
  const requests: Array<{ url: URL; init?: RequestInit }> = []; let index = 0;
  return { requests, now, sleep: async () => undefined, fetch: async (input, init) => { requests.push({ url: new URL(input instanceof Request ? input.url : String(input)), init }); const raw = values[index++]; const response = raw && typeof raw === "object" && !Array.isArray(raw) && "body" in raw ? raw as { body: unknown; headers?: Record<string, string> } : { body: raw }; return new Response(typeof response.body === "string" ? response.body : JSON.stringify(response.body), { status: 200, headers: response.headers }); } };
}

describe("third-wave scientific schemas", () => {
  it("rejects unknown fields and invalid identifiers", () => {
    expect(uniprotSearchInput.safeParse({ query: "TP53", raw_url: "https://example.test" }).success).toBe(false);
    expect(genbankSequenceInput.safeParse({ accession: "not an accession" }).success).toBe(false);
    expect(openTargetsSearchInput.safeParse({ query: "TP53", entity_types: ["person"] }).success).toBe(false);
  });

  it("requires bounded GenBank intervals and an explicit ChEMBL subject", () => {
    expect(genbankSequenceInput.safeParse({ accession: "NM_000546.6", sequence_start: 10 }).success).toBe(false);
    expect(genbankSequenceInput.safeParse({ accession: "NM_000546.6", sequence_start: 1, sequence_stop: 1_000_003 }).success).toBe(false);
    expect(chemblActivitySearchInput.safeParse({ standard_type: "IC50" }).success).toBe(false);
  });
});

describe("third-wave provider mappings", () => {
  it("maps UniProt filters, cursor pagination, and compact entries", async () => {
    const dependencies = responses({ body: { results: [{ primaryAccession: "P04637", uniProtkbId: "P53_HUMAN", proteinDescription: { recommendedName: { fullName: { value: "Cellular tumor antigen p53" } } }, genes: [{ geneName: { value: "TP53" } }], organism: { scientificName: "Homo sapiens", taxonId: 9606 }, sequence: { length: 393 } }] }, headers: { "x-total-results": "17", link: '<https://rest.uniprot.org/uniprotkb/search?cursor=next-token>; rel="next"' } });
    const result = await searchUniprotProteins({ query: "TP53", organism_id: 9606, reviewed: true, include_isoforms: false, size: 10, sort_by: "accession", sort_order: "ascending" }, dependencies);
    expect(dependencies.requests[0]!.url.searchParams.get("query")).toContain("organism_id:9606"); expect(dependencies.requests[0]!.url.searchParams.get("sort")).toBe("accession asc"); expect(result).toMatchObject({ total: 17, next_page_token: "next-token", records: [{ accession: "P04637", genes: ["TP53"] }] });
  });

  it("retrieves a compact UniProt entry with optional sequence", async () => {
    const dependencies = responses({ primaryAccession: "P04637", sequence: { length: 3, value: "MEE" }, comments: [{ commentType: "FUNCTION", texts: [{ value: "Tumor suppressor." }] }] });
    const result = await getUniprotEntry({ accession: "P04637", include_sequence: true }, dependencies);
    expect(dependencies.requests[0]!.url.pathname).toBe("/uniprotkb/P04637.json"); expect(result.record).toMatchObject({ accession: "P04637", sequence: { value: "MEE" }, functions: ["Tumor suppressor."] });
  });

  it("searches GenBank then retrieves bounded NCBI and ENA records", async () => {
    const search = responses({ esearchresult: { count: "1", idlist: ["123"] } }, { result: { "123": { caption: "NM_000546", accessionversion: "NM_000546.6", title: "TP53 transcript", organism: "Homo sapiens", slen: 2591 } } });
    const found = await searchGenbankSequences({ query: "TP53", organism: "Homo sapiens", limit: 5, offset: 0, sort_by: "publication_date" }, search); expect(search.requests[0]!.url.searchParams.get("term")).toContain("Homo sapiens[Organism]"); expect(search.requests[1]!.url.searchParams.get("id")).toBe("123"); expect(found.records[0]).toMatchObject({ accession_version: "NM_000546.6" });
    const genbank = responses(">NM_000546.6\nACGTACGT\n"); const sequence = await getGenbankSequence({ accession: "NM_000546.6", format: "fasta", sequence_start: 1, sequence_stop: 4, strand: "reverse", max_characters: 10 }, genbank); expect(genbank.requests[0]!.url.searchParams.get("strand")).toBe("2"); expect(sequence.record).toMatchObject({ truncated: true, total_characters: 22 });
    const ena = responses(">ENA|U49845\nACGT\n"); await getEnaSequence({ accession: "U49845", max_characters: 5_000 }, ena); expect(ena.requests[0]!.url.pathname).toBe("/ena/browser/api/fasta/U49845");
  });

  it("uses fixed Open Targets GraphQL documents and variables", async () => {
    const search = responses({ data: { search: { total: 1, hits: [{ id: "ENSG00000141510", name: "TP53", entity: "target" }] } } }); const found = await searchOpenTargetsEntities({ query: "TP53", entity_types: ["target"], page: 0, page_size: 5 }, search); const body = JSON.parse(String(search.requests[0]!.init?.body)); expect(body.variables).toEqual({ query: "TP53", entities: ["target"], page: { index: 0, size: 5 } }); expect(found.total).toBe(1);
    const target = responses({ data: { target: { id: "ENSG00000141510", approvedSymbol: "TP53", associatedDiseases: { count: 1, rows: [{ score: 0.9, disease: { id: "MONDO_1", name: "Disease" } }] } } } }); const detail = await getOpenTargetsTarget({ ensembl_gene_id: "ENSG00000141510", association_page: 0, association_page_size: 5, include_indirect: false }, target); expect(detail.record).toMatchObject({ approvedSymbol: "TP53" });
  });

  it("maps ChEMBL molecule, target, and activity filters", async () => {
    const molecules = responses({ page_meta: { total_count: 1, next: "/next" }, molecules: [{ molecule_chembl_id: "CHEMBL25", pref_name: "ASPIRIN", max_phase: "4.0" }] }); const moleculeResult = await searchChemblMolecules({ query: "aspirin", molecule_type: "Small molecule", minimum_phase: 2, limit: 5, offset: 0 }, molecules); expect(molecules.requests[0]!.url.searchParams.get("max_phase__gte")).toBe("2"); expect(moleculeResult.records[0]).toMatchObject({ molecule_chembl_id: "CHEMBL25" });
    const targets = responses({ page_meta: { total_count: 1 }, targets: [{ target_chembl_id: "CHEMBL203", pref_name: "EGFR" }] }); await searchChemblTargets({ query: "EGFR", organism: "Homo sapiens", limit: 5, offset: 0 }, targets); expect(targets.requests[0]!.url.searchParams.get("organism__iexact")).toBe("Homo sapiens");
    const activities = responses({ page_meta: { total_count: 1 }, activities: [{ activity_id: 1, molecule_chembl_id: "CHEMBL25", standard_type: "IC50" }] }); await searchChemblActivities({ molecule_chembl_id: "CHEMBL25", standard_type: "IC50", minimum_pchembl: 5, limit: 5, offset: 0 }, activities); expect(activities.requests[0]!.url.searchParams.get("pchembl_value__gte")).toBe("5");
  });
});
