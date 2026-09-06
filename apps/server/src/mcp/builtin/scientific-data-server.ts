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
import {
  biomartDatasetsInput, biomartQueryInput, chebiSearchInput, drugsFdaSearchInput, encodeRecordInput,
  encodeSearchInput, geoSearchInput, getEncodeRecord, getGwasStudy, getInterproProteinAnnotations,
  getOpenFdaLabel, getPubchemCompound, getStringNetwork, gwasAssociationsInput, gwasStudiesInput,
  gwasStudyInput, interproProteinInput, interproSearchInput, jasparSearchInput, listBiomartDatasets,
  mgnifySearchInput, openFdaLabelInput, openFdaLabelSearchInput, prideSearchInput,
  pubchemCompoundInput, pubchemSearchInput,
  queryBiomart, searchChebiEntities, searchDrugsFda, searchEncodeRecords, searchGeoDatasets,
  searchGwasAssociations, searchGwasStudies, searchInterproEntries, searchJasparMatrices,
  searchMgnifyStudies, searchOpenFdaLabels, searchPrideProjects, searchPubchemCompounds,
  stringNetworkInput,
} from "./scientific-data-secondary.js";

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
  case "protein_annotation":
    server.registerTool("search_interpro_entries", { title: "Search InterPro Entries", description: "Search InterPro protein families, domains, repeats, sites, and homologous superfamilies with cursor pagination.", inputSchema: interproSearchInput, annotations }, async (input) => result(await searchInterproEntries(input)));
    server.registerTool("get_interpro_protein_annotations", { title: "Get Protein Annotations", description: "Retrieve InterPro entries and locations matching a UniProt accession.", inputSchema: interproProteinInput, annotations }, async (input) => result(await getInterproProteinAnnotations(input)));
    server.registerTool("get_string_network", { title: "Get STRING Network", description: "Retrieve a version-pinned STRING v12 interaction network with species, score, network-type, and expansion controls.", inputSchema: stringNetworkInput, annotations }, async (input) => result(await getStringNetwork(input)));
    break;
  case "omics_archives":
    server.registerTool("search_geo_datasets", { title: "Search GEO Datasets", description: "Search NCBI GEO DataSets with relevance/date sorting and pagination.", inputSchema: geoSearchInput, annotations }, async (input) => result(await searchGeoDatasets(input)));
    server.registerTool("search_pride_projects", { title: "Search PRIDE Projects", description: "Search public PRIDE Archive proteomics projects with pagination.", inputSchema: prideSearchInput, annotations }, async (input) => result(await searchPrideProjects(input)));
    server.registerTool("search_mgnify_studies", { title: "Search MGnify Studies", description: "Search public MGnify metagenomics studies with pagination.", inputSchema: mgnifySearchInput, annotations }, async (input) => result(await searchMgnifyStudies(input)));
    break;
  case "chemistry":
    server.registerTool("search_pubchem_compounds", { title: "Search PubChem Compounds", description: "Resolve a chemical name to PubChem compound identifiers and physicochemical properties.", inputSchema: pubchemSearchInput, annotations }, async (input) => result(await searchPubchemCompounds(input)));
    server.registerTool("get_pubchem_compound", { title: "Get PubChem Compound", description: "Retrieve physicochemical properties and bounded synonyms for a PubChem CID.", inputSchema: pubchemCompoundInput, annotations }, async (input) => result(await getPubchemCompound(input)));
    server.registerTool("search_chebi_entities", { title: "Search ChEBI Entities", description: "Search ChEBI chemical entities with page and result-size controls.", inputSchema: chebiSearchInput, annotations }, async (input) => result(await searchChebiEntities(input)));
    break;
  case "regulation":
    server.registerTool("search_encode_records", { title: "Search ENCODE Records", description: "Search public ENCODE experiments, biosamples, files, or annotations by status.", inputSchema: encodeSearchInput, annotations }, async (input) => result(await searchEncodeRecords(input)));
    server.registerTool("get_encode_record", { title: "Get ENCODE Record", description: "Retrieve a public ENCODE object by accession.", inputSchema: encodeRecordInput, annotations }, async (input) => result(await getEncodeRecord(input)));
    server.registerTool("search_jaspar_matrices", { title: "Search JASPAR Matrices", description: "Search JASPAR transcription-factor profiles with collection, taxonomy, ordering, and pagination controls.", inputSchema: jasparSearchInput, annotations }, async (input) => result(await searchJasparMatrices(input)));
    break;
  case "biomart":
    server.registerTool("list_biomart_datasets", { title: "List BioMart Datasets", description: "List datasets in an Ensembl BioMart mart.", inputSchema: biomartDatasetsInput, annotations }, async (input) => result(await listBiomartDatasets(input)));
    server.registerTool("query_biomart", { title: "Query BioMart", description: "Query Ensembl BioMart with validated dataset, attribute, filter, uniqueness, and row-limit parameters.", inputSchema: biomartQueryInput, annotations }, async (input) => result(await queryBiomart(input)));
    break;
  case "drug_regulatory":
    server.registerTool("search_openfda_labels", { title: "Search Drug Labels", description: "Search openFDA structured product labels by a controlled label field.", inputSchema: openFdaLabelSearchInput, annotations }, async (input) => result(await searchOpenFdaLabels(input)));
    server.registerTool("get_openfda_label", { title: "Get Drug Label", description: "Retrieve one compact openFDA structured product label by SPL set identifier.", inputSchema: openFdaLabelInput, annotations }, async (input) => result(await getOpenFdaLabel(input)));
    server.registerTool("search_drugs_fda", { title: "Search Drugs@FDA", description: "Search approved drug application records by ingredient, sponsor, or application number.", inputSchema: drugsFdaSearchInput, annotations }, async (input) => result(await searchDrugsFda(input)));
    break;
  case "human_genetics":
    server.registerTool("search_gwas_studies", { title: "Search GWAS Studies", description: "Search GWAS Catalog v2 studies by reported trait, EFO trait, PubMed ID, or GCST accession.", inputSchema: gwasStudiesInput, annotations }, async (input) => result(await searchGwasStudies(input)));
    server.registerTool("search_gwas_associations", { title: "Search GWAS Associations", description: "Search GWAS Catalog v2 associations by EFO trait, rsID, mapped gene, or GCST accession.", inputSchema: gwasAssociationsInput, annotations }, async (input) => result(await searchGwasAssociations(input)));
    server.registerTool("get_gwas_study", { title: "Get GWAS Study", description: "Retrieve one GWAS Catalog v2 study by GCST accession.", inputSchema: gwasStudyInput, annotations }, async (input) => result(await getGwasStudy(input)));
    break;
  default:
    throw new Error(`Unknown scientific data connector '${domain ?? ""}'`);
}

await server.connect(new StdioServerTransport());

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
}
