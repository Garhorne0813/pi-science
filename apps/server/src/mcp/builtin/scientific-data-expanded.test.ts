import { describe, expect, it } from "vitest";
import type { ScientificDependencies } from "./scientific-data.js";
import {
  arrayExpressSearchInput, bindingDbLigandsInput, cellGuideMarkersInput, emdbSearchInput,
  getBindingDbLigands, getCellGuideMarkers, getChemblMechanisms, getOpenTargetsDrug,
  getPhewasVariant, getQuickGoAnnotations, getUcscTrackData, intactSearchInput,
  listBiomartSchema, listMetabolightsStudies, listUcscTracks, openTargetsDrugInput,
  phewasVariantInput, rheaSearchInput, searchArrayExpress, searchComplexPortal,
  searchEmdbEntries, searchIntactInteractions, searchRheaReactions, searchUnibindDatasets,
  ucscTrackDataInput, unibindSearchInput,
} from "./scientific-data-expanded.js";

const now = () => new Date("2026-09-06T00:00:00.000Z");
function responses(...values: Array<unknown | string>): ScientificDependencies & { requests: Array<{ url: URL; init?: RequestInit }> } {
  const requests: Array<{ url: URL; init?: RequestInit }> = []; let index = 0;
  return { requests, now, sleep: async () => undefined, fetch: async (input, init) => { requests.push({ url: new URL(input instanceof Request ? input.url : String(input)), init }); const value = values[index++]; return new Response(typeof value === "string" ? value : JSON.stringify(value), { status: 200 }); } };
}

describe("expanded scientific connector schemas", () => {
  it("uses strict schemas and bounded regions", () => {
    expect(emdbSearchInput.safeParse({ query: "ribosome", raw_url: "https://example.test" }).success).toBe(false);
    expect(ucscTrackDataInput.safeParse({ genome: "hg38", track: "knownGene", chromosome: "chr1", start: 0, end: 6_000_000 }).success).toBe(false);
    expect(intactSearchInput.safeParse({ query: "TP53", minimum_mi_score: 0.8, maximum_mi_score: 0.2 }).success).toBe(false);
    expect(rheaSearchInput.safeParse({ query: "not-chebi", search_field: "chebi" }).success).toBe(true);
    expect(openTargetsDrugInput.safeParse({ chembl_id: "CHEMBL25", arbitrary_graphql: "query {}" }).success).toBe(false);
  });
});

describe("expanded scientific provider mappings", () => {
  it("maps EMDB, IntAct, and Complex Portal requests", async () => {
    const emdb = responses([{ emdb_id: "EMD-1234", title: "Map" }]); const maps = await searchEmdbEntries({ query: "ribosome", rows: 2, page: 3 }, emdb); expect(emdb.requests[0]!.url.pathname).toBe("/emdb/api/search/ribosome"); expect(emdb.requests[0]!.url.searchParams.get("page")).toBe("3"); expect(maps.count).toBe(1);
    const intact = responses({ data: { totalElements: 9, last: false, content: [{ ac: "EBI-1", intactMiscore: 0.7 }] } }); const interactions = await searchIntactInteractions({ query: "TP53", minimum_mi_score: 0.4, maximum_mi_score: 1, page: 0, page_size: 2 }, intact); expect(intact.requests[0]!.init?.method).toBe("POST"); expect(intact.requests[0]!.url.searchParams.get("minMIScore")).toBe("0.4"); expect(interactions).toMatchObject({ total: 9, next_page_token: 1, records: [{ interaction_ac: "EBI-1" }] });
    const complexes = responses({ totalNumberOfResults: 1, elements: [{ complexAC: "CPX-1" }] }); const found = await searchComplexPortal({ query: "TP53", limit: 5, offset: 0, species: "Homo sapiens" }, complexes); expect(complexes.requests[0]!.url.searchParams.get("filters")).toContain("Homo sapiens"); expect(found.total).toBe(1);
  });

  it("maps ArrayExpress and MetaboLights archive requests", async () => {
    const arrayexpress = responses({ page: 1, pageSize: 2, totalHits: 3, hits: [{ accession: "E-MTAB-1" }] }); const found = await searchArrayExpress(arrayExpressSearchInput.parse({ query: "TP53", organism: "Homo sapiens", page_size: 2 }), arrayexpress); expect(arrayexpress.requests[0]!.url.pathname).toContain("/arrayexpress/search"); expect(arrayexpress.requests[0]!.url.searchParams.get("facet.organism")).toBe("homo sapiens"); expect(found.next_page_token).toBe(2);
    const metabolights = responses({ content: ["MTBLS1", "MTBLS2", "MTBLS20"] }); const studies = await listMetabolightsStudies({ query: "2", limit: 2, offset: 0 }, metabolights); expect(studies).toMatchObject({ total: 2, records: [{ accession: "MTBLS2" }, { accession: "MTBLS20" }] });
  });

  it("maps BindingDB and Rhea chemistry requests", async () => {
    const binding = responses({ response: { affinities: [{ monomerid: "1" }, { monomerid: "2" }] } }); const ligands = await getBindingDbLigands(bindingDbLigandsInput.parse({ uniprot_accession: "P04637", max_records: 1 }), binding); expect(binding.requests[0]!.url.searchParams.get("uniprot")).toBe("P04637"); expect(ligands).toMatchObject({ total: 2, count: 1, warnings: [expect.stringContaining("truncated")] });
    const rhea = responses({ results: { bindings: [{ rhea: { value: "http://rdf.rhea-db.org/123" }, equation: { value: "A = B" } }] } }); const reactions = await searchRheaReactions({ query: "water", search_field: "text", limit: 5 }, rhea); expect(rhea.requests[0]!.init?.method).toBe("POST"); expect(String(rhea.requests[0]!.init?.body)).toContain("SELECT+DISTINCT"); expect(reactions.records[0]).toMatchObject({ equation: "A = B" });
  });

  it("maps UniBind, UCSC, and CellGuide requests", async () => {
    const unibind = responses({ count: 1, results: [{ tf_name: "TP53" }] }); await searchUnibindDatasets(unibindSearchInput.parse({ tf_name: "TP53" }), unibind); expect(unibind.requests[0]!.url.searchParams.get("tf_name")).toBe("TP53");
    const tracks = responses({ positionMatches: [{ name: "trackDb", matches: [{ position: "refGene", description: "RefSeq" }] }] }); const listed = await listUcscTracks({ genome: "hg38", query: "refseq", limit: 10 }, tracks); expect(listed.records).toEqual([{ position: "refGene", description: "RefSeq" }]);
    const track = responses({ knownGene: [{ chrom: "chr1" }], itemsReturned: 1 }); const rows = await getUcscTrackData({ genome: "hg38", track: "knownGene", chromosome: "chr1", start: 1, end: 100, max_items: 10 }, track); expect(track.requests[0]!.url.searchParams.get("end")).toBe("100"); expect(rows.count).toBe(1);
    const cell = responses("12345", [{ symbol: "TP53", marker_score: 1 }]); const markers = await getCellGuideMarkers(cellGuideMarkersInput.parse({ cell_ontology_id: "CL:0000123" }), cell); expect(cell.requests[1]!.url.pathname).toContain("/computational_marker_genes/CL_0000123.json"); expect(markers.count).toBe(1);
  });

  it("maps genetics, ontology, BioMart, Open Targets, and ChEMBL requests", async () => {
    const phewas = responses({ results: [{ phenocode: "C3_CANCER" }, { phenocode: "C4" }] }); const associations = await getPhewasVariant(phewasVariantInput.parse({ variant: "chr17:7673803:C:T", limit: 1 }), phewas); expect(phewas.requests[0]!.url.pathname).toBe("/api/variant/17-7673803-C-T"); expect(associations.count).toBe(1);
    const quickgo = responses({ numberOfHits: 1, pageInfo: { current: 1, total: 1 }, results: [{ goId: "GO:1" }] }); const annotations = await getQuickGoAnnotations({ gene_product_id: "UniProtKB:P04637", limit: 10, page: 1 }, quickgo); expect(quickgo.requests[0]!.url.searchParams.get("geneProductId")).toBe("UniProtKB:P04637"); expect(annotations.total).toBe(1);
    const biomart = responses("name\tName\tDescription\tpage\tstring\n"); const schema = await listBiomartSchema({ dataset: "hsapiens_gene_ensembl", kind: "attributes" }, biomart); expect(schema.records[0]).toMatchObject({ name: "name", display_name: "Name" });
    const openTargets = responses({ data: { drug: { id: "CHEMBL25", name: "ASPIRIN" } } }); const drug = await getOpenTargetsDrug({ chembl_id: "CHEMBL25" }, openTargets); expect(JSON.parse(String(openTargets.requests[0]!.init?.body)).variables).toEqual({ id: "CHEMBL25" }); expect(drug.record).toMatchObject({ name: "ASPIRIN" });
    const chembl = responses({ page_meta: { total_count: 1 }, mechanisms: [{ mechanism_of_action: "inhibitor" }] }); const mechanisms = await getChemblMechanisms({ molecule_chembl_id: "CHEMBL25", limit: 5, offset: 0 }, chembl); expect(chembl.requests[0]!.url.searchParams.get("molecule_chembl_id")).toBe("CHEMBL25"); expect(mechanisms.total).toBe(1);
  });
});
