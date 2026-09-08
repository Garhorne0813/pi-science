import { describe, expect, it } from "vitest";
import {
  biomartQueryInput, encodeSearchInput, getEncodeRecord, getGwasStudy, getPubchemCompound, getStringNetwork,
  gwasAssociationsInput, interproSearchInput, listBiomartDatasets, openFdaLabelSearchInput,
  queryBiomart, searchChebiEntities, searchDrugsFda, searchEncodeRecords, searchGeoDatasets,
  searchGwasAssociations, searchInterproEntries, searchJasparMatrices, searchMgnifyStudies,
  searchOpenFdaLabels, searchPrideProjects, searchPubchemCompounds,
} from "./scientific-data-secondary.js";
import type { ScientificDependencies } from "./scientific-data.js";

const now = () => new Date("2026-09-06T00:00:00.000Z");
function responses(...values: unknown[]): ScientificDependencies & { requests: Array<{ url: URL; init?: RequestInit }> } {
  const requests: Array<{ url: URL; init?: RequestInit }> = []; let index = 0;
  return { requests, now, sleep: async () => undefined, fetch: async (input, init) => { requests.push({ url: new URL(input instanceof Request ? input.url : String(input)), init }); const value = values[index++]; return new Response(typeof value === "string" ? value : JSON.stringify(value), { status: 200 }); } };
}

describe("second-wave scientific schemas", () => {
  it("rejects unknown parameters and unbounded provider syntax", () => {
    expect(interproSearchInput.safeParse({ query: "kinase", max_results: 20 }).success).toBe(false);
    expect(openFdaLabelSearchInput.safeParse({ query: "aspirin", field: "raw_search" }).success).toBe(false);
    expect(encodeSearchInput.safeParse({ query: "CTCF", record_type: "User" }).success).toBe(false);
  });

  it("requires an explicit GWAS association filter", () => {
    expect(gwasAssociationsInput.safeParse({}).success).toBe(false);
  });

  it("validates BioMart names while allowing typed filter maps", () => {
    expect(biomartQueryInput.safeParse({ dataset: "hsapiens_gene_ensembl", attributes: ["ensembl_gene_id"], filters: { chromosome_name: ["1", "2"] } }).success).toBe(true);
    expect(biomartQueryInput.safeParse({ dataset: "bad<dataset", attributes: ["gene"] }).success).toBe(false);
  });
});

describe("second-wave provider mappings", () => {
  it("maps InterPro search type and cursor", async () => {
    const dependencies = responses({ count: 1, next: "https://www.ebi.ac.uk/interpro/api/entry/interpro?cursor=next", results: [{ metadata: { accession: "IPR1", name: "Kinase", type: "domain" } }] });
    const result = await searchInterproEntries({ query: "kinase", entry_type: "domain", page_size: 5, cursor: "current" }, dependencies);
    expect(dependencies.requests[0]!.url.searchParams.get("type")).toBe("domain"); expect(dependencies.requests[0]!.url.searchParams.get("cursor")).toBe("current"); expect(result).toMatchObject({ total: 1, next_page_token: "next", records: [{ accession: "IPR1" }] });
  });

  it("maps STRING identifiers and scoring controls", async () => {
    const dependencies = responses([{ preferredName_A: "TP53", preferredName_B: "MDM2", score: 0.99 }]);
    const result = await getStringNetwork({ identifiers: ["TP53", "MDM2"], species: 9606, required_score: 700, network_type: "physical", add_nodes: 2 }, dependencies);
    const url = dependencies.requests[0]!.url; expect(url.hostname).toBe("version-12-0.string-db.org"); expect(url.searchParams.get("identifiers")).toBe("TP53\rMDM2"); expect(url.searchParams.get("required_score")).toBe("700"); expect(result.count).toBe(1);
  });

  it("performs GEO ID search followed by summaries", async () => {
    const dependencies = responses({ esearchresult: { count: "1", idlist: ["200001"] } }, { result: { "200001": { accession: "GSE1", title: "Dataset" } } });
    const result = await searchGeoDatasets({ query: "single cell", limit: 5, offset: 10, sort_by: "date" }, dependencies);
    expect(dependencies.requests[0]!.url.searchParams.get("db")).toBe("gds"); expect(dependencies.requests[0]!.url.searchParams.get("retstart")).toBe("10"); expect(dependencies.requests[1]!.url.searchParams.get("id")).toBe("200001"); expect(result.total).toBe(1);
  });

  it("maps PRIDE and MGnify pagination", async () => {
    const pride = responses([{ accession: "PXD1", title: "Proteome" }]); await searchPrideProjects({ keyword: "proteome", page: 2, page_size: 5 }, pride); expect(pride.requests[0]!.url.searchParams.get("pageSize")).toBe("5");
    const mgnify = responses({ count: 1, items: [{ accession: "MGYS1", title: "Gut" }] }); const result = await searchMgnifyStudies({ query: "gut", page: 3, page_size: 7 }, mgnify); expect(mgnify.requests[0]!.url.pathname).toContain("/api/v2/studies/"); expect(mgnify.requests[0]!.url.searchParams.get("page")).toBe("3"); expect(result.total).toBe(1);
  });

  it("maps PubChem name lookup and bounded compound synonyms", async () => {
    const search = responses({ PropertyTable: { Properties: [{ CID: 2244, Title: "Aspirin" }] } }); const found = await searchPubchemCompounds({ name: "aspirin", max_records: 5 }, search); expect(decodeURIComponent(search.requests[0]!.url.pathname)).toContain("/name/aspirin/property/"); expect(found.records[0]).toMatchObject({ CID: 2244 });
    const detail = responses({ PropertyTable: { Properties: [{ CID: 2244 }] } }, { InformationList: { Information: [{ Synonym: ["A", "B", "C"] }] } }); const record = await getPubchemCompound({ cid: 2244, synonym_limit: 2 }, detail); expect(record.record).toMatchObject({ CID: 2244, synonyms: ["A", "B"] });
  });

  it("compacts ChEBI search hits", async () => {
    const dependencies = responses({ total: 1, results: [{ _source: { chebi_accession: "CHEBI:15365", name: "aspirin" } }] }); const result = await searchChebiEntities({ query: "aspirin", page: 1, page_size: 10 }, dependencies); expect(result).toMatchObject({ total: 1, records: [{ chebi_accession: "CHEBI:15365" }] });
  });

  it("maps ENCODE and JASPAR controlled filters", async () => {
    const encode = responses({ total: 1, "@graph": [{ accession: "ENCSR1", assay_title: "ChIP-seq", "@id": "/experiments/ENCSR1/" }] }); const encoded = await searchEncodeRecords({ query: "CTCF", record_type: "Experiment", status: "released", limit: 5 }, encode); expect(encode.requests[0]!.url.searchParams.get("frame")).toBe("object"); expect(encoded.records[0]).toMatchObject({ accession: "ENCSR1" });
    const jaspar = responses({ count: 1, results: [{ matrix_id: "MA0106.1", name: "TP53" }] }); await searchJasparMatrices({ query: "TP53", collection: "CORE", tax_id: [9606], page: 1, page_size: 5, order: "name" }, jaspar); expect(jaspar.requests[0]!.url.searchParams.get("tax_id")).toBe("9606");
  });

  it("retrieves ENCODE records without following an accession redirect", async () => {
    const dependencies = responses({ "@graph": [{ accession: "ENCSR727LLE", assay_title: "HiC" }] }); const result = await getEncodeRecord({ accession: "ENCSR727LLE" }, dependencies); expect(dependencies.requests[0]!.url.pathname).toBe("/search/"); expect(dependencies.requests[0]!.url.searchParams.get("searchTerm")).toBe("ENCSR727LLE"); expect(result.record).toMatchObject({ accession: "ENCSR727LLE" });
  });

  it("parses BioMart datasets and tabular query output", async () => {
    const list = responses("TableSet\thsapiens_gene_ensembl\tHuman genes\t1\tGRCh38\t1\t2026\tdefault\n"); const listed = await listBiomartDatasets({ mart: "ENSEMBL_MART_ENSEMBL", include_archived: false }, list); expect(listed.records[0]).toMatchObject({ dataset: "hsapiens_gene_ensembl", assembly: "GRCh38" });
    const queryResult = responses("Gene stable ID\tGene name\nENSG1\tTP53\n"); const queried = await queryBiomart({ dataset: "hsapiens_gene_ensembl", attributes: ["ensembl_gene_id", "external_gene_name"], filters: { chromosome_name: "17" }, limit: 10, unique_rows: true }, queryResult); const xml = queryResult.requests[0]!.url.searchParams.get("query")!; expect(xml).toContain('<Filter name="chromosome_name" value="17"/>'); expect(queried.records[0]).toEqual({ "Gene stable ID": "ENSG1", "Gene name": "TP53" });
  });

  it("escapes openFDA terms and maps controlled search fields", async () => {
    const label = responses({ meta: { results: { total: 1 } }, results: [{ set_id: "abc", openfda: { generic_name: ["ASPIRIN"] }, indications_and_usage: ["Pain"] }] }); const result = await searchOpenFdaLabels({ query: 'aspirin" OR _exists_:x', field: "generic_name", limit: 5, skip: 0 }, label); expect(label.requests[0]!.url.searchParams.get("search")).toBe('openfda.generic_name:"aspirin OR _exists_:x"'); expect(result.records[0]).toMatchObject({ set_id: "abc", indications_and_usage: "Pain" });
    const drugs = responses({ meta: { results: { total: 1 } }, results: [{ application_number: "NDA001", sponsor_name: "Test" }] }); await searchDrugsFda({ query: "aspirin", field: "active_ingredient", limit: 5, skip: 0 }, drugs); expect(drugs.requests[0]!.url.searchParams.get("search")).toContain("products.active_ingredients.name");
  });

  it("maps GWAS Catalog v2 filters and pagination", async () => {
    const dependencies = responses({ _embedded: { associations: [{ association_id: 1, mapped_genes: ["TCF7L2"] }] }, page: { totalElements: 3 }, _links: { next: { href: "https://next" } } }); const result = await searchGwasAssociations({ rs_id: "rs7903146", page: 0, page_size: 10 }, dependencies); expect(dependencies.requests[0]!.url.searchParams.get("rs_id")).toBe("rs7903146"); expect(result).toMatchObject({ total: 3, next_page_token: "https://next", records: [{ association_id: 1 }] });
  });

  it("uses the stable GWAS study detail endpoint", async () => {
    const dependencies = responses({ accessionId: "GCST90979336", diseaseTrait: { trait: "Asthma" } }); const result = await getGwasStudy({ accession_id: "GCST90979336" }, dependencies); expect(dependencies.requests[0]!.url.pathname).toBe("/gwas/rest/api/studies/GCST90979336"); expect(result.record).toMatchObject({ accessionId: "GCST90979336" });
  });
});
