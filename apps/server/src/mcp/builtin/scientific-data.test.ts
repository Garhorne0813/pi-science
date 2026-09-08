import { describe, expect, it } from "vitest";
import {
  analyzeClinicalTrialEndpoints, cellTypeSearchInput, clinicalTrialEligibilityInput,
  clinicalTrialsSearchInput, ensemblVepInput, getAlphaFoldPrediction, getClinicalTrial,
  getOpenAlexCitations, getOpenAlexReferences, myGeneInput, openAlexAuthorSearchInput,
  openAlexReferencesInput, openAlexSearchInput, pdbSearchInput, queryMyGene, runEnsemblVep,
  searchCellTypes, searchClinicalTrialEligibility, searchClinicalTrials, searchOpenAlexAuthors,
  searchOpenAlexWorks, searchOntologyTerms, searchPdbEntries, type ScientificDependencies,
} from "./scientific-data.js";

const now = () => new Date("2026-09-06T00:00:00.000Z");
function responses(...bodies: unknown[]): ScientificDependencies & { requests: Array<{ url: URL; init?: RequestInit }> } {
  const requests: Array<{ url: URL; init?: RequestInit }> = []; let index = 0;
  return { requests, now, sleep: async () => undefined, fetch: async (input, init) => { requests.push({ url: new URL(input instanceof Request ? input.url : String(input)), init }); const value = bodies[index++]; return new Response(typeof value === "string" ? value : JSON.stringify(value), { status: 200 }); } };
}

describe("scientific data schemas", () => {
  it("rejects unknown parameters and invalid enum values", () => {
    expect(openAlexSearchInput.safeParse({ query: "CRISPR", max_results: 10 }).success).toBe(false);
    expect(openAlexReferencesInput.safeParse({ work_id: "W1", limit: 101 }).success).toBe(false);
    expect(openAlexAuthorSearchInput.safeParse({ query: "Jane Doe", cursor: "*" }).success).toBe(false);
    expect(clinicalTrialEligibilityInput.safeParse({ criteria: "adult", unknown: true }).success).toBe(false);
    expect(clinicalTrialsSearchInput.safeParse({ condition: "cancer", overall_status: ["OPEN"] }).success).toBe(false);
    expect(ensemblVepInput.safeParse({ region: "9:1-1", allele: "not-an-allele" }).success).toBe(false);
  });

  it("requires at least one clinical-trial search criterion", () => {
    expect(clinicalTrialsSearchInput.safeParse({}).success).toBe(false);
  });
});

describe("scientific data provider mappings", () => {
  it("maps OpenAlex filters, sorting, and pagination", async () => {
    const dependencies = responses({ meta: { count: 3 }, results: [{ id: "https://openalex.org/W1", title: "Work", cited_by_count: 7, primary_location: { source: { display_name: "Journal" } } }] });
    const result = await searchOpenAlexWorks(openAlexSearchInput.parse({ query: "protein design", publication_year_from: 2020, publication_year_to: 2026, work_type: "article", open_access: true, author_id: "A123", sort_by: "citation_count", per_page: 5, page: 2 }), dependencies);
    const url = dependencies.requests[0]!.url;
    expect(url.searchParams.get("filter")).toBe("from_publication_date:2020-01-01,to_publication_date:2026-12-31,type:article,is_oa:true,author.id:A123");
    expect(url.searchParams.get("sort")).toBe("cited_by_count:desc"); expect(url.searchParams.get("per-page")).toBe("5"); expect(url.searchParams.get("page")).toBe("2");
    expect(result).toMatchObject({ source: "openalex", total: 3, records: [{ openalex_id: "https://openalex.org/W1", source: "Journal" }] });
  });

  it("resolves a DOI before requesting OpenAlex citations", async () => {
    const dependencies = responses({ id: "https://openalex.org/W42", title: "Seed" }, { meta: { count: 1, next_cursor: "next" }, results: [{ id: "https://openalex.org/W43", title: "Citing" }] });
    const result = await getOpenAlexCitations({ work_id: "10.1000/test", per_page: 10, cursor: "*" }, dependencies);
    expect(dependencies.requests[0]!.url.pathname).toContain(encodeURIComponent("https://doi.org/10.1000/test"));
    expect(dependencies.requests[1]!.url.searchParams.get("filter")).toBe("cites:W42");
    expect(result).toMatchObject({ next_page_token: "next", records: [{ title: "Citing" }] });
  });

  it("retrieves bounded OpenAlex references and searches authors", async () => {
    const dependencies = responses(
      { id: "https://openalex.org/W42", referenced_works: ["https://openalex.org/W1", "https://openalex.org/W2", "https://openalex.org/W3"] },
      { results: [{ id: "https://openalex.org/W1", title: "Reference" }] },
      { meta: { count: 1 }, results: [{ id: "https://openalex.org/A1", display_name: "Jane Doe", works_count: 5 }] },
    );
    const references = await getOpenAlexReferences({ work_id: "W42", limit: 2 }, dependencies);
    expect(dependencies.requests[1]!.url.searchParams.get("filter")).toBe("openalex_id:W1|W2");
    expect(references).toMatchObject({ total: 2, records: [{ title: "Reference" }] });
    const authors = await searchOpenAlexAuthors({ query: "Jane Doe", per_page: 10, page: 2 }, dependencies);
    expect(dependencies.requests[2]!.url.pathname).toBe("/authors");
    expect(dependencies.requests[2]!.url.searchParams.get("page")).toBe("2");
    expect(authors).toMatchObject({ total: 1, records: [{ display_name: "Jane Doe", works_count: 5 }] });
  });

  it("maps ClinicalTrials.gov field filters and compacts results", async () => {
    const dependencies = responses({ totalCount: 1, nextPageToken: "token", studies: [{ protocolSection: { identificationModule: { nctId: "NCT12345678", briefTitle: "Trial" }, statusModule: { overallStatus: "RECRUITING" }, designModule: { phases: ["PHASE2"], studyType: "INTERVENTIONAL" }, conditionsModule: { conditions: ["Cancer"] } } }] });
    const result = await searchClinicalTrials(clinicalTrialsSearchInput.parse({ condition: "cancer", intervention: "drug", overall_status: ["RECRUITING"], phase: ["PHASE2"], study_type: "INTERVENTIONAL", page_size: 5, sort_by: "last_update" }), dependencies);
    const url = dependencies.requests[0]!.url;
    expect(url.searchParams.get("query.cond")).toBe("cancer"); expect(url.searchParams.get("filter.overallStatus")).toBe("RECRUITING"); expect(url.searchParams.get("filter.advanced")).toContain("AREA[Phase](PHASE2)");
    expect(result).toMatchObject({ total: 1, next_page_token: "token", records: [{ nct_id: "NCT12345678", overall_status: "RECRUITING" }] });
  });

  it("normalizes NCT IDs for direct retrieval", async () => {
    const dependencies = responses({ protocolSection: { identificationModule: { nctId: "NCT12345678" } } });
    await getClinicalTrial({ nct_id: "nct12345678" }, dependencies);
    expect(dependencies.requests[0]!.url.pathname.endsWith("/NCT12345678")).toBe(true);
  });

  it("searches eligibility modules and extracts trial endpoints", async () => {
    const dependencies = responses(
      { totalCount: 1, studies: [{ protocolSection: { identificationModule: { nctId: "NCT12345678" } } }] },
      { protocolSection: { identificationModule: { nctId: "NCT12345678" }, designModule: { phases: ["PHASE2"], enrollmentInfo: { count: 120 } }, outcomesModule: { primaryOutcomes: [{ measure: "Overall survival" }], secondaryOutcomes: [{ measure: "Safety" }] } } },
    );
    const eligibility = await searchClinicalTrialEligibility({ criteria: "adult", condition: "cancer", page_size: 5 }, dependencies);
    expect(dependencies.requests[0]!.url.searchParams.get("query.term")).toBe("AREA[EligibilityCriteria]adult");
    expect(eligibility).toMatchObject({ total: 1, records: [{ nct_id: "NCT12345678" }] });
    const endpoints = await analyzeClinicalTrialEndpoints({ nct_id: "NCT12345678" }, dependencies);
    expect(endpoints).toMatchObject({ record: { nct_id: "NCT12345678", primary_outcomes: [{ measure: "Overall survival" }], phases: ["PHASE2"] } });
  });

  it("sends the documented RCSB full-text POST payload", async () => {
    const dependencies = responses({ total_count: 1, result_set: [{ identifier: "1ABC", score: 1 }] });
    const result = await searchPdbEntries(pdbSearchInput.parse({ query: "hemoglobin", limit: 5, offset: 10 }), dependencies);
    const body = JSON.parse(String(dependencies.requests[0]!.init?.body));
    expect(dependencies.requests[0]!.init?.method).toBe("POST"); expect(body).toMatchObject({ query: { service: "full_text", parameters: { value: "hemoglobin" } }, request_options: { paginate: { start: 10, rows: 5 } } });
    expect(result).toMatchObject({ total: 1, records: [{ identifier: "1ABC" }] });
  });

  it("retrieves AlphaFold predictions by normalized UniProt accession", async () => {
    const dependencies = responses([{ entryId: "AF-P69905-F1", pdbUrl: "https://example.test/model.pdb" }]);
    const result = await getAlphaFoldPrediction({ uniprot_accession: "P69905" }, dependencies);
    expect(dependencies.requests[0]!.url.pathname.endsWith("/P69905")).toBe(true); expect(result).toMatchObject({ count: 1, records: [{ entryId: "AF-P69905-F1" }] });
  });

  it("maps MyGene fields and species", async () => {
    const dependencies = responses({ total: 1, hits: [{ symbol: "TP53" }] });
    const result = await queryMyGene(myGeneInput.parse({ query: "TP53", species: "human", fields: ["symbol", "entrezgene"], size: 5 }), dependencies);
    expect(dependencies.requests[0]!.url.searchParams.get("fields")).toBe("symbol,entrezgene"); expect(result).toMatchObject({ total: 1, records: [{ symbol: "TP53" }] });
  });

  it("maps OLS ontology and exact-match controls", async () => {
    const dependencies = responses({ response: { numFound: 2, docs: [{ iri: "x", label: "T cell" }] } });
    const result = await searchOntologyTerms({ query: "T cell", ontology: "CL", exact: true, include_obsolete: false, rows: 10, start: 0 }, dependencies);
    expect(dependencies.requests[0]!.url.searchParams.get("ontology")).toBe("cl"); expect(dependencies.requests[0]!.url.searchParams.get("exact")).toBe("true"); expect(result.total).toBe(2);
  });

  it("maps Ensembl VEP region, alleles, and output flags", async () => {
    const dependencies = responses([{ input: "9 22125503 . G A" }]);
    await runEnsemblVep({ region: "chr9:22125503-22125503", allele: "G/A", canonical: true, mane: true, protein: false }, dependencies);
    const url = dependencies.requests[0]!.url; expect(decodeURIComponent(url.pathname)).toContain("/9:22125503-22125503/G/A"); expect(url.searchParams.get("protein")).toBe("0");
  });

  it("searches the current CellGuide snapshot locally", async () => {
    const dependencies = responses("1764612212", { "CL:0000084": { id: "CL:0000084", name: "T cell", clDescription: "A lymphocyte", synonyms: ["T lymphocyte"] }, "CL:0000540": { id: "CL:0000540", name: "neuron", synonyms: [] } });
    const result = await searchCellTypes(cellTypeSearchInput.parse({ query: "T lymphocyte", limit: 5 }), dependencies);
    expect(dependencies.requests[1]!.url.pathname).toContain("/1764612212/celltype_metadata.json"); expect(result).toMatchObject({ count: 1, records: [{ id: "CL:0000084" }] });
  });
});
