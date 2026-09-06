import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpConnectorCreate, McpToolSummary } from "@pi-science/contracts";

export interface BuiltinMcpConnector {
  connector_id: string;
  enabled_by_default: boolean;
  definition: Omit<McpConnectorCreate, "enabled">;
  tools: McpToolSummary[];
}

export function builtinMcpConnectors(): BuiltinMcpConnector[] {
  const runtime = paperSearchRuntime();
  return [{
    connector_id: "mcp_builtin_paper_search",
    enabled_by_default: true,
    definition: {
      name: "paper-search",
      display_name: "Paper Search",
      description: "Search PubMed, arXiv, and Crossref for verifiable scientific literature metadata.",
      transport: "stdio",
      endpoint_url: null,
      command: runtime.command,
      args: runtime.args,
      socket_path: null,
      runtime_config: { lifecycle: "lazy", expose_resources: false, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "none", allow_private: false, terms_url: "https://www.crossref.org/documentation/retrieve-metadata/rest-api/", privacy_url: "https://www.nlm.nih.gov/web_policies.html" },
      credential_ref: null,
    },
    tools: [
      { name: "search_pubmed", title: "Search PubMed", description: "Search PubMed metadata with field, date, sort, and pagination controls.", read_only: true, decision: "ask" },
      { name: "search_arxiv", title: "Search arXiv", description: "Search arXiv preprints with category, field, date-sort, ID, and pagination controls.", read_only: true, decision: "ask" },
      { name: "search_crossref", title: "Search Crossref", description: "Search Crossref metadata with fielded queries, filters, sorting, and pagination.", read_only: true, decision: "ask" },
    ],
  }, ...scientificDataConnectors()];
}

const scientificDomains = [
  {
    id: "literature_graph", name: "literature-graph", display: "Literature Graph",
    description: "Search OpenAlex works and traverse citation relationships.",
    terms: "https://openalex.org/terms",
    tools: [
      tool("search_openalex_works", "Search OpenAlex Works", "Search scholarly works with publication, type, access, author, source, and citation filters."),
      tool("get_openalex_work", "Get OpenAlex Work", "Retrieve a scholarly work by OpenAlex ID, DOI, PMID, or URL."),
      tool("get_openalex_citations", "Get OpenAlex Citations", "List works that cite a specified OpenAlex work."),
    ],
  },
  {
    id: "clinical_trials", name: "clinical-trials", display: "Clinical Trials",
    description: "Search and retrieve ClinicalTrials.gov study records.",
    terms: "https://clinicaltrials.gov/about-site/terms-conditions",
    tools: [
      tool("search_clinical_trials", "Search Clinical Trials", "Search ClinicalTrials.gov with condition, intervention, location, status, phase, and study-type filters."),
      tool("get_clinical_trial", "Get Clinical Trial", "Retrieve the current ClinicalTrials.gov record for an NCT identifier."),
    ],
  },
  {
    id: "structures", name: "structures-interactions", display: "Structures & Interactions",
    description: "Retrieve and search public PDB and AlphaFold structure metadata.",
    terms: "https://www.rcsb.org/pages/policies",
    tools: [
      tool("search_pdb_entries", "Search PDB Entries", "Full-text search of RCSB PDB entries or polymer entities."),
      tool("get_pdb_entry", "Get PDB Entry", "Retrieve core RCSB PDB metadata for a PDB entry."),
      tool("get_alphafold_prediction", "Get AlphaFold Prediction", "Retrieve AlphaFold DB prediction metadata for a UniProt accession."),
    ],
  },
  {
    id: "genes_ontologies", name: "genes-ontologies", display: "Genes & Ontologies",
    description: "Resolve genes and query OLS and Reactome knowledge services.",
    terms: "https://www.ebi.ac.uk/about/terms-of-use",
    tools: [
      tool("query_mygene", "Query MyGene", "Resolve gene symbols and identifiers through MyGene.info."),
      tool("search_ontology_terms", "Search Ontology Terms", "Search EBI OLS ontology terms with ontology and exact-match controls."),
      tool("map_reactome_pathways", "Map Reactome Pathways", "Find Reactome pathways associated with a UniProt identifier."),
    ],
  },
  {
    id: "genomes", name: "genomes", display: "Genomes",
    description: "Query Ensembl gene annotations, sequences, and human VEP consequences.",
    terms: "https://www.ensembl.org/info/about/legal/disclaimer.html",
    tools: [
      tool("lookup_ensembl_id", "Look Up Ensembl ID", "Retrieve annotation for an Ensembl stable identifier."),
      tool("get_ensembl_sequence", "Get Ensembl Sequence", "Retrieve genomic, cDNA, CDS, or protein sequence for an Ensembl identifier."),
      tool("run_ensembl_vep", "Run Ensembl VEP", "Predict consequences for a human genomic variant."),
    ],
  },
  {
    id: "cellguide", name: "cellguide", display: "CellGuide",
    description: "Search CELLxGENE CellGuide cell types and retrieve curated metadata.",
    terms: "https://cellxgene.cziscience.com/tos",
    tools: [
      tool("search_cell_types", "Search Cell Types", "Search CELLxGENE CellGuide names, synonyms, descriptions, and ontology identifiers."),
      tool("get_cell_type", "Get Cell Type", "Retrieve CELLxGENE CellGuide metadata for a Cell Ontology identifier."),
    ],
  },
  {
    id: "protein_annotation", name: "protein-annotation", display: "Protein Annotation",
    description: "Query InterPro protein families and STRING interaction networks.",
    terms: "https://www.ebi.ac.uk/interpro/about/license/",
    tools: [
      tool("search_interpro_entries", "Search InterPro Entries", "Search InterPro families, domains, sites, and other protein signatures."),
      tool("get_interpro_protein_annotations", "Get Protein Annotations", "Retrieve InterPro annotations for a UniProt accession."),
      tool("get_string_network", "Get STRING Network", "Retrieve a scored STRING protein-interaction network."),
    ],
  },
  {
    id: "omics_archives", name: "omics-archives", display: "Omics Archives",
    description: "Search GEO, PRIDE Archive, and MGnify study metadata.",
    terms: "https://www.ebi.ac.uk/about/terms-of-use",
    tools: [
      tool("search_geo_datasets", "Search GEO Datasets", "Search NCBI GEO DataSets metadata."),
      tool("search_pride_projects", "Search PRIDE Projects", "Search public PRIDE proteomics projects."),
      tool("search_mgnify_studies", "Search MGnify Studies", "Search public MGnify metagenomics studies."),
    ],
  },
  {
    id: "chemistry", name: "chemistry", display: "Chemistry",
    description: "Resolve PubChem compounds and search ChEBI chemical entities.",
    terms: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
    tools: [
      tool("search_pubchem_compounds", "Search PubChem Compounds", "Resolve a chemical name to PubChem compound properties."),
      tool("get_pubchem_compound", "Get PubChem Compound", "Retrieve PubChem properties and synonyms for a CID."),
      tool("search_chebi_entities", "Search ChEBI Entities", "Search ChEBI names, identifiers, formulae, and structures."),
    ],
  },
  {
    id: "regulation", name: "regulation", display: "Regulation",
    description: "Search ENCODE experiments and JASPAR transcription-factor profiles.",
    terms: "https://www.encodeproject.org/help/rest-api/",
    tools: [
      tool("search_encode_records", "Search ENCODE Records", "Search released ENCODE experiments, biosamples, files, and annotations."),
      tool("get_encode_record", "Get ENCODE Record", "Retrieve a public ENCODE metadata record by accession."),
      tool("search_jaspar_matrices", "Search JASPAR Matrices", "Search JASPAR transcription-factor binding profiles."),
    ],
  },
  {
    id: "biomart", name: "biomart", display: "BioMart",
    description: "List and query Ensembl BioMart datasets with explicit attributes and filters.",
    terms: "https://www.ensembl.org/info/about/legal/disclaimer.html",
    tools: [
      tool("list_biomart_datasets", "List BioMart Datasets", "List datasets in an Ensembl BioMart mart."),
      tool("query_biomart", "Query BioMart", "Query an Ensembl BioMart dataset using validated attributes and filters."),
    ],
  },
  {
    id: "drug_regulatory", name: "drug-regulatory", display: "Drug Regulatory",
    description: "Search public openFDA drug labels and Drugs@FDA application records.",
    terms: "https://open.fda.gov/terms/",
    tools: [
      tool("search_openfda_labels", "Search Drug Labels", "Search openFDA structured product labels by a controlled field."),
      tool("get_openfda_label", "Get Drug Label", "Retrieve an openFDA label by SPL set identifier."),
      tool("search_drugs_fda", "Search Drugs@FDA", "Search Drugs@FDA applications by ingredient, sponsor, or application number."),
    ],
  },
  {
    id: "human_genetics", name: "human-genetics", display: "Human Genetics",
    description: "Search curated NHGRI-EBI GWAS Catalog studies and associations.",
    terms: "https://www.ebi.ac.uk/about/terms-of-use",
    tools: [
      tool("search_gwas_studies", "Search GWAS Studies", "Search curated GWAS Catalog studies by trait, publication, or accession."),
      tool("search_gwas_associations", "Search GWAS Associations", "Search GWAS Catalog associations by trait, variant, gene, or study."),
      tool("get_gwas_study", "Get GWAS Study", "Retrieve a GWAS Catalog study by GCST accession."),
    ],
  },
  {
    id: "protein_records", name: "protein-records", display: "Protein Records",
    description: "Search and retrieve UniProtKB protein records and sequences.",
    terms: "https://www.uniprot.org/help/terms",
    tools: [
      tool("search_uniprot_proteins", "Search UniProt Proteins", "Search UniProtKB with organism, review-status, pagination, and sorting controls."),
      tool("get_uniprot_entry", "Get UniProt Entry", "Retrieve a compact UniProtKB entry by accession."),
      tool("get_uniprot_sequence", "Get UniProt Sequence", "Retrieve a bounded UniProtKB FASTA sequence by accession."),
    ],
  },
  {
    id: "nucleotide_archives", name: "nucleotide-archives", display: "Nucleotide Archives",
    description: "Search NCBI GenBank and retrieve bounded sequence records from NCBI and ENA.",
    terms: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
    tools: [
      tool("search_genbank_sequences", "Search GenBank Sequences", "Search NCBI Nucleotide records with organism, date, sorting, and pagination controls."),
      tool("get_genbank_sequence", "Get GenBank Sequence", "Retrieve a bounded GenBank or FASTA record by accession, optionally for a sequence interval."),
      tool("get_ena_sequence", "Get ENA Sequence", "Retrieve a bounded FASTA record from the European Nucleotide Archive."),
    ],
  },
  {
    id: "target_discovery", name: "target-discovery", display: "Target Discovery",
    description: "Search Open Targets entities and retrieve ranked target-disease associations.",
    terms: "https://www.opentargets.org/terms-and-conditions",
    tools: [
      tool("search_open_targets_entities", "Search Open Targets", "Search Open Targets genes, diseases, drugs, variants, and studies with controlled entity filters."),
      tool("get_open_targets_target", "Get Open Targets Target", "Retrieve target metadata and ranked disease associations by Ensembl gene ID."),
    ],
  },
  {
    id: "chembl", name: "chembl", display: "ChEMBL",
    description: "Search ChEMBL compounds, targets, and measured bioactivities.",
    terms: "https://www.ebi.ac.uk/about/terms-of-use",
    tools: [
      tool("search_chembl_molecules", "Search ChEMBL Molecules", "Search ChEMBL compounds with development-phase and molecule-type filters."),
      tool("search_chembl_targets", "Search ChEMBL Targets", "Search ChEMBL targets with organism and target-type filters."),
      tool("search_chembl_activities", "Search ChEMBL Activities", "Search measured ChEMBL bioactivities for an explicit molecule or target."),
    ],
  },
] as const;

function scientificDataConnectors(): BuiltinMcpConnector[] {
  const runtime = scientificDataRuntime();
  return scientificDomains.map((domain) => ({
    connector_id: `mcp_builtin_${domain.id}`,
    enabled_by_default: false,
    definition: {
      name: domain.name,
      display_name: domain.display,
      description: domain.description,
      transport: "stdio",
      endpoint_url: null,
      command: runtime.command,
      args: [...runtime.args, domain.id],
      socket_path: null,
      runtime_config: { lifecycle: "lazy", expose_resources: false, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "none", allow_private: false, terms_url: domain.terms },
      credential_ref: null,
    },
    tools: [...domain.tools],
  }));
}

function tool(name: string, title: string, description: string): McpToolSummary {
  return { name, title, description, read_only: true, decision: "ask" };
}

function paperSearchRuntime(): { command: string; args: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = resolve(here, "builtin", "paper-search-server.js");
  if (existsSync(compiled)) return { command: process.execPath, args: [compiled] };
  // Source-mode servers run through tsx; use its CLI so the spawned MCP child
  // can execute the TypeScript entrypoint without depending on a user Python.
  const source = resolve(here, "builtin", "paper-search-server.ts");
  const tsx = process.env.PI_TSX_PATH ?? resolve(here, "../../node_modules/.bin/tsx");
  return existsSync(source) ? { command: tsx, args: [source] } : { command: process.execPath, args: [compiled] };
}

function scientificDataRuntime(): { command: string; args: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = resolve(here, "builtin", "scientific-data-server.js");
  if (existsSync(compiled)) return { command: process.execPath, args: [compiled] };
  const source = resolve(here, "builtin", "scientific-data-server.ts");
  const tsx = process.env.PI_TSX_PATH ?? resolve(here, "../../node_modules/.bin/tsx");
  return existsSync(source) ? { command: tsx, args: [source] } : { command: process.execPath, args: [compiled] };
}
