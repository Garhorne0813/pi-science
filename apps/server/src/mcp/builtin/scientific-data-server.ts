import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  alphaFoldInput, analyzeClinicalTrialEndpoints, cellTypeInput, cellTypeSearchInput,
  clinicalTrialEligibilityInput, clinicalTrialInput, clinicalTrialsSearchInput,
  ensemblLookupInput, ensemblSequenceInput, ensemblVepInput, getAlphaFoldPrediction, getCellType,
  getClinicalTrial, getEnsemblSequence, getOpenAlexCitations, getOpenAlexReferences, getOpenAlexWork,
  getPdbEntry,
  lookupEnsemblId, mapReactomePathways, myGeneInput, ontologySearchInput, openAlexCitationsInput,
  openAlexAuthorSearchInput, openAlexReferencesInput, openAlexSearchInput, openAlexWorkInput,
  pdbEntryInput, pdbSearchInput, queryMyGene, reactomePathwayInput, runEnsemblVep, searchCellTypes,
  searchClinicalTrialEligibility, searchClinicalTrials, searchOntologyTerms, searchOpenAlexAuthors,
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
import {
  chemblActivitySearchInput, chemblMoleculeSearchInput, chemblTargetSearchInput, enaSequenceInput,
  genbankSearchInput, genbankSequenceInput, getEnaSequence, getGenbankSequence, getOpenTargetsTarget,
  getUniprotEntry, getUniprotSequence, openTargetsSearchInput, openTargetsTargetInput,
  searchChemblActivities, searchChemblMolecules, searchChemblTargets, searchGenbankSequences,
  searchOpenTargetsEntities, searchUniprotProteins, uniprotEntryInput, uniprotSearchInput,
  uniprotSequenceInput,
} from "./scientific-data-tertiary.js";
import {
  arrayExpressSearchInput, arrayExpressStudyInput, bindingDbLigandsInput, bindingDbTargetsInput,
  biomartSchemaInput, cellGuideMarkersInput, cellGuideRelatedInput, chemblMechanismInput,
  complexPortalSearchInput, drugsFdaApplicationInput, emdbEntryInput, emdbSearchInput,
  getArrayExpressStudy, getBindingDbLigands, getBindingDbTargets, getCellGuideMarkers,
  getCellGuideSources, getCellGuideTissues, getChemblMechanisms, getDrugsFdaApplication,
  getEmdbEntry, getHumanProteinAtlasGene, getMetabolightsStudy, getOntologyTerm,
  getOpenTargetsDisease, getOpenTargetsDrug, getPhewasVariant, getQuickGoAnnotations,
  getRheaReaction, getUcscTrackData, getUnibindDataset, humanProteinAtlasInput,
  intactSearchInput, listBiomartSchema, listMetabolightsStudies, listUcscTracks,
  metabolightsListInput, metabolightsStudyInput, ontologyTermInput, openTargetsDiseaseInput,
  openTargetsDrugInput, phewasSearchInput, phewasVariantInput, quickGoAnnotationsInput,
  rheaEntryInput, rheaSearchInput, searchArrayExpress, searchComplexPortal, searchEmdbEntries,
  searchIntactInteractions, searchPhewas, searchRheaReactions, searchUnibindDatasets,
  ucscTrackDataInput, ucscTracksInput, unibindDatasetInput, unibindSearchInput,
} from "./scientific-data-expanded.js";

const domain = process.argv[2];
const server = new McpServer({ name: `pi-science-${domain ?? "scientific-data"}`, version: "1.0.0" });
const annotations = { readOnlyHint: true, openWorldHint: true } as const;

switch (domain) {
  case "literature_graph":
    server.registerTool("search_openalex_works", { title: "Search OpenAlex Works", description: "Search OpenAlex scholarly works. Supports publication-year, work-type, open-access, author, source, sorting, and pagination controls.", inputSchema: openAlexSearchInput, annotations }, async (input) => result(await searchOpenAlexWorks(input)));
    server.registerTool("get_openalex_work", { title: "Get OpenAlex Work", description: "Retrieve one OpenAlex work by W-id, DOI, PMID, or canonical URL.", inputSchema: openAlexWorkInput, annotations }, async (input) => result(await getOpenAlexWork(input)));
    server.registerTool("get_openalex_citations", { title: "Get OpenAlex Citations", description: "List works citing an OpenAlex work, ordered by citation count with cursor pagination.", inputSchema: openAlexCitationsInput, annotations }, async (input) => result(await getOpenAlexCitations(input)));
    server.registerTool("get_openalex_references", { title: "Get OpenAlex References", description: "Resolve and retrieve bounded works referenced by an OpenAlex work.", inputSchema: openAlexReferencesInput, annotations }, async (input) => result(await getOpenAlexReferences(input)));
    server.registerTool("search_openalex_authors", { title: "Search OpenAlex Authors", description: "Search OpenAlex author profiles with bounded pagination.", inputSchema: openAlexAuthorSearchInput, annotations }, async (input) => result(await searchOpenAlexAuthors(input)));
    break;
  case "clinical_trials":
    server.registerTool("search_clinical_trials", { title: "Search Clinical Trials", description: "Search ClinicalTrials.gov studies by terms, condition, intervention, location, status, phase, and study type.", inputSchema: clinicalTrialsSearchInput, annotations }, async (input) => result(await searchClinicalTrials(input)));
    server.registerTool("get_clinical_trial", { title: "Get Clinical Trial", description: "Retrieve the current ClinicalTrials.gov record for an NCT identifier.", inputSchema: clinicalTrialInput, annotations }, async (input) => result(await getClinicalTrial(input)));
    server.registerTool("search_clinical_trial_eligibility", { title: "Search Trial Eligibility", description: "Search ClinicalTrials.gov eligibility modules with optional condition and location filters.", inputSchema: clinicalTrialEligibilityInput, annotations }, async (input) => result(await searchClinicalTrialEligibility(input)));
    server.registerTool("analyze_clinical_trial_endpoints", { title: "Analyze Trial Endpoints", description: "Extract primary, secondary, and other outcomes plus design context from a trial.", inputSchema: clinicalTrialInput, annotations }, async (input) => result(await analyzeClinicalTrialEndpoints(input)));
    break;
  case "structures":
    server.registerTool("search_pdb_entries", { title: "Search PDB Entries", description: "Run an RCSB PDB full-text search with result type and pagination controls.", inputSchema: pdbSearchInput, annotations }, async (input) => result(await searchPdbEntries(input)));
    server.registerTool("get_pdb_entry", { title: "Get PDB Entry", description: "Retrieve the RCSB core entry record for a four-character PDB identifier.", inputSchema: pdbEntryInput, annotations }, async (input) => result(await getPdbEntry(input)));
    server.registerTool("get_alphafold_prediction", { title: "Get AlphaFold Prediction", description: "Retrieve AlphaFold DB prediction metadata and structure file URLs for a UniProt accession.", inputSchema: alphaFoldInput, annotations }, async (input) => result(await getAlphaFoldPrediction(input)));
    server.registerTool("search_emdb_entries", { title: "Search EMDB Entries", description: "Search bounded Electron Microscopy Data Bank metadata.", inputSchema: emdbSearchInput, annotations }, async (input) => result(await searchEmdbEntries(input)));
    server.registerTool("get_emdb_entry", { title: "Get EMDB Entry", description: "Retrieve compact EMDB metadata by EMD accession.", inputSchema: emdbEntryInput, annotations }, async (input) => result(await getEmdbEntry(input)));
    server.registerTool("search_intact_interactions", { title: "Search IntAct Interactions", description: "Search molecular interactions with score, species, and pagination controls.", inputSchema: intactSearchInput, annotations }, async (input) => result(await searchIntactInteractions(input)));
    server.registerTool("search_complex_portal", { title: "Search Complex Portal", description: "Search curated macromolecular complexes by term or participant.", inputSchema: complexPortalSearchInput, annotations }, async (input) => result(await searchComplexPortal(input)));
    break;
  case "genes_ontologies":
    server.registerTool("query_mygene", { title: "Query MyGene", description: "Search MyGene.info with species, return-field, and pagination controls.", inputSchema: myGeneInput, annotations }, async (input) => result(await queryMyGene(input)));
    server.registerTool("search_ontology_terms", { title: "Search Ontology Terms", description: "Search EBI OLS terms with ontology, exact-match, obsolete-term, and pagination controls.", inputSchema: ontologySearchInput, annotations }, async (input) => result(await searchOntologyTerms(input)));
    server.registerTool("map_reactome_pathways", { title: "Map Reactome Pathways", description: "Map a UniProt accession to Reactome pathways for a species.", inputSchema: reactomePathwayInput, annotations }, async (input) => result(await mapReactomePathways(input)));
    server.registerTool("get_ontology_term", { title: "Get Ontology Term", description: "Retrieve an OLS term and optionally its direct children.", inputSchema: ontologyTermInput, annotations }, async (input) => result(await getOntologyTerm(input)));
    server.registerTool("get_go_annotations", { title: "Get GO Annotations", description: "Retrieve bounded QuickGO annotations for a gene product.", inputSchema: quickGoAnnotationsInput, annotations }, async (input) => result(await getQuickGoAnnotations(input)));
    break;
  case "genomes":
    server.registerTool("lookup_ensembl_id", { title: "Look Up Ensembl ID", description: "Retrieve Ensembl annotation with transcript expansion, MANE, and phenotype controls.", inputSchema: ensemblLookupInput, annotations }, async (input) => result(await lookupEnsemblId(input)));
    server.registerTool("get_ensembl_sequence", { title: "Get Ensembl Sequence", description: "Retrieve genomic, cDNA, CDS, or protein sequence for an Ensembl stable identifier.", inputSchema: ensemblSequenceInput, annotations }, async (input) => result(await getEnsemblSequence(input)));
    server.registerTool("run_ensembl_vep", { title: "Run Ensembl VEP", description: "Predict consequences for a human region and reference/alternate allele pair.", inputSchema: ensemblVepInput, annotations }, async (input) => result(await runEnsemblVep(input)));
    server.registerTool("list_ucsc_tracks", { title: "List UCSC Tracks", description: "List or filter bounded track metadata for a UCSC genome assembly.", inputSchema: ucscTracksInput, annotations }, async (input) => result(await listUcscTracks(input)));
    server.registerTool("get_ucsc_track_data", { title: "Get UCSC Track Data", description: "Retrieve bounded UCSC track records for a genomic interval.", inputSchema: ucscTrackDataInput, annotations }, async (input) => result(await getUcscTrackData(input)));
    break;
  case "cellguide":
    server.registerTool("search_cell_types", { title: "Search Cell Types", description: "Search the current CELLxGENE CellGuide snapshot by name, synonym, description, or Cell Ontology ID.", inputSchema: cellTypeSearchInput, annotations }, async (input) => result(await searchCellTypes(input)));
    server.registerTool("get_cell_type", { title: "Get Cell Type", description: "Retrieve CellGuide metadata for a Cell Ontology identifier.", inputSchema: cellTypeInput, annotations }, async (input) => result(await getCellType(input)));
    server.registerTool("get_cell_type_markers", { title: "Get Cell Type Markers", description: "Retrieve bounded computational or canonical CellGuide marker genes.", inputSchema: cellGuideMarkersInput, annotations }, async (input) => result(await getCellGuideMarkers(input)));
    server.registerTool("get_cell_type_sources", { title: "Get Cell Type Sources", description: "Retrieve CellGuide source collections and publications.", inputSchema: cellGuideRelatedInput, annotations }, async (input) => result(await getCellGuideSources(input)));
    server.registerTool("get_cell_type_tissues", { title: "Get Cell Type Tissues", description: "Retrieve tissues associated with a CellGuide cell type.", inputSchema: cellGuideRelatedInput, annotations }, async (input) => result(await getCellGuideTissues(input)));
    break;
  case "protein_annotation":
    server.registerTool("search_interpro_entries", { title: "Search InterPro Entries", description: "Search InterPro protein families, domains, repeats, sites, and homologous superfamilies with cursor pagination.", inputSchema: interproSearchInput, annotations }, async (input) => result(await searchInterproEntries(input)));
    server.registerTool("get_interpro_protein_annotations", { title: "Get Protein Annotations", description: "Retrieve InterPro entries and locations matching a UniProt accession.", inputSchema: interproProteinInput, annotations }, async (input) => result(await getInterproProteinAnnotations(input)));
    server.registerTool("get_string_network", { title: "Get STRING Network", description: "Retrieve a version-pinned STRING v12 interaction network with species, score, network-type, and expansion controls.", inputSchema: stringNetworkInput, annotations }, async (input) => result(await getStringNetwork(input)));
    server.registerTool("get_human_protein_atlas_gene", { title: "Get Human Protein Atlas Gene", description: "Retrieve a compact or full Human Protein Atlas gene record.", inputSchema: humanProteinAtlasInput, annotations }, async (input) => result(await getHumanProteinAtlasGene(input)));
    break;
  case "omics_archives":
    server.registerTool("search_geo_datasets", { title: "Search GEO Datasets", description: "Search NCBI GEO DataSets with relevance/date sorting and pagination.", inputSchema: geoSearchInput, annotations }, async (input) => result(await searchGeoDatasets(input)));
    server.registerTool("search_pride_projects", { title: "Search PRIDE Projects", description: "Search public PRIDE Archive proteomics projects with pagination.", inputSchema: prideSearchInput, annotations }, async (input) => result(await searchPrideProjects(input)));
    server.registerTool("search_mgnify_studies", { title: "Search MGnify Studies", description: "Search public MGnify metagenomics studies with pagination.", inputSchema: mgnifySearchInput, annotations }, async (input) => result(await searchMgnifyStudies(input)));
    server.registerTool("search_arrayexpress", { title: "Search ArrayExpress", description: "Search the ArrayExpress collection through the current BioStudies API.", inputSchema: arrayExpressSearchInput, annotations }, async (input) => result(await searchArrayExpress(input)));
    server.registerTool("get_arrayexpress_study", { title: "Get ArrayExpress Study", description: "Retrieve a public ArrayExpress record from BioStudies.", inputSchema: arrayExpressStudyInput, annotations }, async (input) => result(await getArrayExpressStudy(input)));
    server.registerTool("list_metabolights_studies", { title: "List MetaboLights Studies", description: "List and locally filter public MetaboLights accessions with bounded pagination.", inputSchema: metabolightsListInput, annotations }, async (input) => result(await listMetabolightsStudies(input)));
    server.registerTool("get_metabolights_study", { title: "Get MetaboLights Study", description: "Retrieve compact public MetaboLights study metadata.", inputSchema: metabolightsStudyInput, annotations }, async (input) => result(await getMetabolightsStudy(input)));
    break;
  case "chemistry":
    server.registerTool("search_pubchem_compounds", { title: "Search PubChem Compounds", description: "Resolve a chemical name to PubChem compound identifiers and physicochemical properties.", inputSchema: pubchemSearchInput, annotations }, async (input) => result(await searchPubchemCompounds(input)));
    server.registerTool("get_pubchem_compound", { title: "Get PubChem Compound", description: "Retrieve physicochemical properties and bounded synonyms for a PubChem CID.", inputSchema: pubchemCompoundInput, annotations }, async (input) => result(await getPubchemCompound(input)));
    server.registerTool("search_chebi_entities", { title: "Search ChEBI Entities", description: "Search ChEBI chemical entities with page and result-size controls.", inputSchema: chebiSearchInput, annotations }, async (input) => result(await searchChebiEntities(input)));
    server.registerTool("get_bindingdb_ligands", { title: "Get BindingDB Ligands", description: "Retrieve bounded measured ligands for a UniProt target.", inputSchema: bindingDbLigandsInput, annotations }, async (input) => result(await getBindingDbLigands(input)));
    server.registerTool("get_bindingdb_targets", { title: "Get BindingDB Targets", description: "Retrieve bounded targets for compounds similar to a SMILES query.", inputSchema: bindingDbTargetsInput, annotations }, async (input) => result(await getBindingDbTargets(input)));
    server.registerTool("search_rhea_reactions", { title: "Search Rhea Reactions", description: "Search curated biochemical reactions by text, ChEBI identifier, or EC number.", inputSchema: rheaSearchInput, annotations }, async (input) => result(await searchRheaReactions(input)));
    server.registerTool("get_rhea_reaction", { title: "Get Rhea Reaction", description: "Retrieve a curated Rhea reaction by accession.", inputSchema: rheaEntryInput, annotations }, async (input) => result(await getRheaReaction(input)));
    break;
  case "regulation":
    server.registerTool("search_encode_records", { title: "Search ENCODE Records", description: "Search public ENCODE experiments, biosamples, files, or annotations by status.", inputSchema: encodeSearchInput, annotations }, async (input) => result(await searchEncodeRecords(input)));
    server.registerTool("get_encode_record", { title: "Get ENCODE Record", description: "Retrieve a public ENCODE object by accession.", inputSchema: encodeRecordInput, annotations }, async (input) => result(await getEncodeRecord(input)));
    server.registerTool("search_jaspar_matrices", { title: "Search JASPAR Matrices", description: "Search JASPAR transcription-factor profiles with collection, taxonomy, ordering, and pagination controls.", inputSchema: jasparSearchInput, annotations }, async (input) => result(await searchJasparMatrices(input)));
    server.registerTool("search_unibind_datasets", { title: "Search UniBind Datasets", description: "Search UniBind transcription-factor binding datasets with controlled filters.", inputSchema: unibindSearchInput, annotations }, async (input) => result(await searchUnibindDatasets(input)));
    server.registerTool("get_unibind_dataset", { title: "Get UniBind Dataset", description: "Retrieve a UniBind dataset and its prediction-model metadata.", inputSchema: unibindDatasetInput, annotations }, async (input) => result(await getUnibindDataset(input)));
    break;
  case "biomart":
    server.registerTool("list_biomart_datasets", { title: "List BioMart Datasets", description: "List datasets in an Ensembl BioMart mart.", inputSchema: biomartDatasetsInput, annotations }, async (input) => result(await listBiomartDatasets(input)));
    server.registerTool("query_biomart", { title: "Query BioMart", description: "Query Ensembl BioMart with validated dataset, attribute, filter, uniqueness, and row-limit parameters.", inputSchema: biomartQueryInput, annotations }, async (input) => result(await queryBiomart(input)));
    server.registerTool("list_biomart_schema", { title: "List BioMart Schema", description: "List attributes or filters accepted by an Ensembl BioMart dataset.", inputSchema: biomartSchemaInput, annotations }, async (input) => result(await listBiomartSchema(input)));
    break;
  case "drug_regulatory":
    server.registerTool("search_openfda_labels", { title: "Search Drug Labels", description: "Search openFDA structured product labels by a controlled label field.", inputSchema: openFdaLabelSearchInput, annotations }, async (input) => result(await searchOpenFdaLabels(input)));
    server.registerTool("get_openfda_label", { title: "Get Drug Label", description: "Retrieve one compact openFDA structured product label by SPL set identifier.", inputSchema: openFdaLabelInput, annotations }, async (input) => result(await getOpenFdaLabel(input)));
    server.registerTool("search_drugs_fda", { title: "Search Drugs@FDA", description: "Search approved drug application records by ingredient, sponsor, or application number.", inputSchema: drugsFdaSearchInput, annotations }, async (input) => result(await searchDrugsFda(input)));
    server.registerTool("get_drugs_fda_application", { title: "Get Drugs@FDA Application", description: "Retrieve a Drugs@FDA application by exact NDA, ANDA, or BLA number.", inputSchema: drugsFdaApplicationInput, annotations }, async (input) => result(await getDrugsFdaApplication(input)));
    break;
  case "human_genetics":
    server.registerTool("search_gwas_studies", { title: "Search GWAS Studies", description: "Search GWAS Catalog v2 studies by reported trait, EFO trait, PubMed ID, or GCST accession.", inputSchema: gwasStudiesInput, annotations }, async (input) => result(await searchGwasStudies(input)));
    server.registerTool("search_gwas_associations", { title: "Search GWAS Associations", description: "Search GWAS Catalog v2 associations by EFO trait, rsID, mapped gene, or GCST accession.", inputSchema: gwasAssociationsInput, annotations }, async (input) => result(await searchGwasAssociations(input)));
    server.registerTool("get_gwas_study", { title: "Get GWAS Study", description: "Retrieve one GWAS Catalog v2 study by GCST accession.", inputSchema: gwasStudyInput, annotations }, async (input) => result(await getGwasStudy(input)));
    server.registerTool("search_phewas", { title: "Search FinnGen PheWAS", description: "Search FinnGen R12 genes and phenotype terms.", inputSchema: phewasSearchInput, annotations }, async (input) => result(await searchPhewas(input)));
    server.registerTool("get_phewas_variant", { title: "Get FinnGen Variant PheWAS", description: "Retrieve bounded phenotype associations for a genomic variant.", inputSchema: phewasVariantInput, annotations }, async (input) => result(await getPhewasVariant(input)));
    break;
  case "protein_records":
    server.registerTool("search_uniprot_proteins", { title: "Search UniProt Proteins", description: "Search UniProtKB with a query plus controlled organism, review-status, isoform, sorting, and cursor-pagination parameters.", inputSchema: uniprotSearchInput, annotations }, async (input) => result(await searchUniprotProteins(input)));
    server.registerTool("get_uniprot_entry", { title: "Get UniProt Entry", description: "Retrieve compact UniProtKB protein, gene, organism, function, and sequence metadata by accession.", inputSchema: uniprotEntryInput, annotations }, async (input) => result(await getUniprotEntry(input)));
    server.registerTool("get_uniprot_sequence", { title: "Get UniProt Sequence", description: "Retrieve a UniProtKB FASTA record with a strict output-size bound.", inputSchema: uniprotSequenceInput, annotations }, async (input) => result(await getUniprotSequence(input)));
    break;
  case "nucleotide_archives":
    server.registerTool("search_genbank_sequences", { title: "Search GenBank Sequences", description: "Search NCBI Nucleotide records with organism, publication-date, sorting, and pagination controls.", inputSchema: genbankSearchInput, annotations }, async (input) => result(await searchGenbankSequences(input)));
    server.registerTool("get_genbank_sequence", { title: "Get GenBank Sequence", description: "Retrieve a bounded GenBank or FASTA record by accession with optional interval and strand controls.", inputSchema: genbankSequenceInput, annotations }, async (input) => result(await getGenbankSequence(input)));
    server.registerTool("get_ena_sequence", { title: "Get ENA Sequence", description: "Retrieve a bounded FASTA record by European Nucleotide Archive accession.", inputSchema: enaSequenceInput, annotations }, async (input) => result(await getEnaSequence(input)));
    break;
  case "target_discovery":
    server.registerTool("search_open_targets_entities", { title: "Search Open Targets", description: "Search Open Targets entities with controlled entity-type and pagination parameters.", inputSchema: openTargetsSearchInput, annotations }, async (input) => result(await searchOpenTargetsEntities(input)));
    server.registerTool("get_open_targets_target", { title: "Get Open Targets Target", description: "Retrieve target metadata, tractability, and ranked disease associations by Ensembl gene ID.", inputSchema: openTargetsTargetInput, annotations }, async (input) => result(await getOpenTargetsTarget(input)));
    server.registerTool("get_open_targets_disease", { title: "Get Open Targets Disease", description: "Retrieve disease metadata, associated targets, and known drugs.", inputSchema: openTargetsDiseaseInput, annotations }, async (input) => result(await getOpenTargetsDisease(input)));
    server.registerTool("get_open_targets_drug", { title: "Get Open Targets Drug", description: "Retrieve drug metadata, mechanisms, and disease indications.", inputSchema: openTargetsDrugInput, annotations }, async (input) => result(await getOpenTargetsDrug(input)));
    break;
  case "chembl":
    server.registerTool("search_chembl_molecules", { title: "Search ChEMBL Molecules", description: "Search ChEMBL molecules with type, development-phase, and pagination filters.", inputSchema: chemblMoleculeSearchInput, annotations }, async (input) => result(await searchChemblMolecules(input)));
    server.registerTool("search_chembl_targets", { title: "Search ChEMBL Targets", description: "Search ChEMBL targets with organism, target-type, and pagination filters.", inputSchema: chemblTargetSearchInput, annotations }, async (input) => result(await searchChemblTargets(input)));
    server.registerTool("search_chembl_activities", { title: "Search ChEMBL Activities", description: "Search measured ChEMBL bioactivities for an explicit molecule or target with assay and potency filters.", inputSchema: chemblActivitySearchInput, annotations }, async (input) => result(await searchChemblActivities(input)));
    server.registerTool("get_chembl_mechanisms", { title: "Get ChEMBL Mechanisms", description: "Retrieve mechanisms of action for a ChEMBL molecule.", inputSchema: chemblMechanismInput, annotations }, async (input) => result(await getChemblMechanisms(input)));
    break;
  default:
    throw new Error(`Unknown scientific data connector '${domain ?? ""}'`);
}

await server.connect(new StdioServerTransport());

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
}
