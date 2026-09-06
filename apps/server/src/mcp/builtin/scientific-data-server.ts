import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  alphaFoldInput, cellTypeInput, cellTypeSearchInput, clinicalTrialInput, clinicalTrialsSearchInput,
  ensemblLookupInput, ensemblSequenceInput, ensemblVepInput, getAlphaFoldPrediction, getCellType,
  getClinicalTrial, getEnsemblSequence, getOpenAlexCitations, getOpenAlexWork, getPdbEntry,
  lookupEnsemblId, mapReactomePathways, myGeneInput, ontologySearchInput, openAlexCitationsInput,
  openAlexSearchInput, openAlexWorkInput, pdbEntryInput, pdbSearchInput, queryMyGene,
  reactomePathwayInput, runEnsemblVep, searchCellTypes, searchClinicalTrials, searchOntologyTerms,
  searchOpenAlexWorks, searchPdbEntries,
} from "./scientific-data.js";

const domain = process.argv[2];
const server = new McpServer({ name: `pi-science-${domain ?? "scientific-data"}`, version: "1.0.0" });
const annotations = { readOnlyHint: true, openWorldHint: true } as const;

switch (domain) {
  case "literature_graph":
    server.registerTool("search_openalex_works", { title: "Search OpenAlex Works", description: "Search OpenAlex scholarly works. Supports publication-year, work-type, open-access, author, source, sorting, and pagination controls.", inputSchema: openAlexSearchInput, annotations }, async (input) => result(await searchOpenAlexWorks(input)));
    server.registerTool("get_openalex_work", { title: "Get OpenAlex Work", description: "Retrieve one OpenAlex work by W-id, DOI, PMID, or canonical URL.", inputSchema: openAlexWorkInput, annotations }, async (input) => result(await getOpenAlexWork(input)));
    server.registerTool("get_openalex_citations", { title: "Get OpenAlex Citations", description: "List works citing an OpenAlex work, ordered by citation count with cursor pagination.", inputSchema: openAlexCitationsInput, annotations }, async (input) => result(await getOpenAlexCitations(input)));
    break;
  case "clinical_trials":
    server.registerTool("search_clinical_trials", { title: "Search Clinical Trials", description: "Search ClinicalTrials.gov studies by terms, condition, intervention, location, status, phase, and study type.", inputSchema: clinicalTrialsSearchInput, annotations }, async (input) => result(await searchClinicalTrials(input)));
    server.registerTool("get_clinical_trial", { title: "Get Clinical Trial", description: "Retrieve the current ClinicalTrials.gov record for an NCT identifier.", inputSchema: clinicalTrialInput, annotations }, async (input) => result(await getClinicalTrial(input)));
    break;
  case "structures":
    server.registerTool("search_pdb_entries", { title: "Search PDB Entries", description: "Run an RCSB PDB full-text search with result type and pagination controls.", inputSchema: pdbSearchInput, annotations }, async (input) => result(await searchPdbEntries(input)));
    server.registerTool("get_pdb_entry", { title: "Get PDB Entry", description: "Retrieve the RCSB core entry record for a four-character PDB identifier.", inputSchema: pdbEntryInput, annotations }, async (input) => result(await getPdbEntry(input)));
    server.registerTool("get_alphafold_prediction", { title: "Get AlphaFold Prediction", description: "Retrieve AlphaFold DB prediction metadata and structure file URLs for a UniProt accession.", inputSchema: alphaFoldInput, annotations }, async (input) => result(await getAlphaFoldPrediction(input)));
    break;
  case "genes_ontologies":
    server.registerTool("query_mygene", { title: "Query MyGene", description: "Search MyGene.info with species, return-field, and pagination controls.", inputSchema: myGeneInput, annotations }, async (input) => result(await queryMyGene(input)));
    server.registerTool("search_ontology_terms", { title: "Search Ontology Terms", description: "Search EBI OLS terms with ontology, exact-match, obsolete-term, and pagination controls.", inputSchema: ontologySearchInput, annotations }, async (input) => result(await searchOntologyTerms(input)));
    server.registerTool("map_reactome_pathways", { title: "Map Reactome Pathways", description: "Map a UniProt accession to Reactome pathways for a species.", inputSchema: reactomePathwayInput, annotations }, async (input) => result(await mapReactomePathways(input)));
    break;
  case "genomes":
    server.registerTool("lookup_ensembl_id", { title: "Look Up Ensembl ID", description: "Retrieve Ensembl annotation with transcript expansion, MANE, and phenotype controls.", inputSchema: ensemblLookupInput, annotations }, async (input) => result(await lookupEnsemblId(input)));
    server.registerTool("get_ensembl_sequence", { title: "Get Ensembl Sequence", description: "Retrieve genomic, cDNA, CDS, or protein sequence for an Ensembl stable identifier.", inputSchema: ensemblSequenceInput, annotations }, async (input) => result(await getEnsemblSequence(input)));
    server.registerTool("run_ensembl_vep", { title: "Run Ensembl VEP", description: "Predict consequences for a human region and reference/alternate allele pair.", inputSchema: ensemblVepInput, annotations }, async (input) => result(await runEnsemblVep(input)));
    break;
  case "cellguide":
    server.registerTool("search_cell_types", { title: "Search Cell Types", description: "Search the current CELLxGENE CellGuide snapshot by name, synonym, description, or Cell Ontology ID.", inputSchema: cellTypeSearchInput, annotations }, async (input) => result(await searchCellTypes(input)));
    server.registerTool("get_cell_type", { title: "Get Cell Type", description: "Retrieve CellGuide metadata for a Cell Ontology identifier.", inputSchema: cellTypeInput, annotations }, async (input) => result(await getCellType(input)));
    break;
  default:
    throw new Error(`Unknown scientific data connector '${domain ?? ""}'`);
}

await server.connect(new StdioServerTransport());

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
}
