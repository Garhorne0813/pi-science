---
name: sequence-analysis
description: Analyze protein and nucleotide sequences — composition, motifs, alignment, and basic statistics. Use when the user provides FASTA sequences or identifiers and wants composition summaries, GC content, ORF finding, pairwise or multiple alignment, motif scanning, or sequence length/charge/hydropathy summaries. Fetches sequences from UniProt/ENA when given accessions; computations run in the session Python kernel with Biopython; results are saved as workspace files (tables, FASTA, alignments) so they stay reproducible.
version: 0.1.0
license: Apache-2.0
category: bioinformatics
requirements:
  - python
risk: low
third_party:
  - kind: library
    name: Biopython (BSD 3-Clause)
    provider: Biopython project
    license: BSD-3-Clause
    info_url: https://biopython.org/
---

# Sequence analysis

Run honest sequence computations in the session kernel and save every result
to the workspace. Never report a number you did not compute.

## Workflow

1. **Obtain sequences.** For accessions, fetch FASTA from UniProt
   (`https://rest.uniprot.org/uniprotkb/{id}.fasta`) or ENA
   (`https://www.ebi.ac.uk/ena/browser/api/fasta/{id}`) and name the source.
   For pasted FASTA, parse it and report how many records and total length
   you received before doing anything else.
2. **Install once if needed:** `pip install biopython`.
3. **Compute what was asked, nothing more:**
   - Composition and length: `SeqIO` + `Counter`; GC content for nucleotides
     with `Bio.SeqUtils.gc_fraction`.
   - ORFs: `Bio.Seq.translate` on the six frames; report coordinates, not
     just counts.
   - Alignments: pairwise with `Bio.Align.PairwiseAligner` (state the scoring
     you chose); multiple alignment needs ClustalW/MAFFT installed — check and
     say so when missing rather than pretending.
   - Motifs: exact/regex search with `re` on the sequence; for motif
     databases (PROSITE/JASPAR) use the corresponding MCP connector if the
     user enabled it, and cite the accession.
   - Protein summaries: molecular weight and pI via `Bio.SeqUtils`, aromaticity
     and hydropathy (Kyte-Doolitle) computed explicitly over the sequence.
4. **Save results:** tables as CSV, alignments as FASTA/Clustal, plots as PNG —
   all under `analysis/` in the workspace so the user can inspect and the
   provenance trail records them.
5. **Report with provenance:** each number in your summary must name the file
   it came from ("mean length 412 aa, from analysis/lengths.csv").

## Constraints

- Never fabricate accessions, motifs, or database entries; if a lookup fails,
  show the error and stop.
- Sequence data can be sensitive (unpublished genes, patient-adjacent data):
  ask before sending any sequence to an external service; local kernel
  computation is always fine.
- For large files (>10k records), process in a streaming loop and report
  progress rather than loading everything into memory.
