---
name: single-cell-rna-qc
description: Quality-control single-cell RNA-seq count matrices — compute per-cell QC metrics (total counts, detected genes, mitochondrial fraction) and filter low-quality cells using median-absolute-deviation (MAD) outlier detection with a configurable mitochondrial cap. Use when the user asks to QC, filter, or assess single-cell RNA-seq data, detect low-quality cells, or follow scverse/scanpy best practices. Core pipeline is numpy/scipy only; scanpy-based extensions are documented but optional.
version: 0.1.0
license: Apache-2.0
category: biology
requirements:
  - name: python
    kind: python
    description: Runs the QC helper script.
  - name: numpy
    kind: package
    description: Core matrix operations (the only required Python package).
  - name: scanpy
    kind: package
    optional: true
    description: Optional advanced pipeline (h5ad/h5 input, embeddings, marker workflows). Not required for the core CSV pipeline.
risk: low
third_party:
  - kind: other
    name: anthropics/life-sciences single-cell-rna-qc (Apache-2.0, workflow reference)
    provider: Anthropic
    license: Apache-2.0
    info_url: https://github.com/anthropics/life-sciences
  - kind: other
    name: scverse / scanpy best-practice QC conventions (MAD filtering)
    provider: scverse
    license: BSD-3-Clause
    info_url: https://scverse.org/
---

# Single-cell RNA-seq quality control

Compute per-cell QC metrics and filter low-quality cells with MAD-based
outlier detection. Core pipeline runs on a plain counts CSV with
numpy/scipy — no scanpy required.

## When to use

- QC or filtering of single-cell RNA-seq count data
- Detect low-quality cells (low counts, low gene detection, high
  mitochondrial fraction)
- Assess data quality before downstream analysis
- Follow scverse/scanpy QC conventions

Supported input: a counts matrix as CSV with **rows = genes** and
**columns = cells**, plus a gene-identifier first column (header
`gene`/`genes`/`symbol`/`feature`, auto-detected). Pass `--no-gene-column`
for a plain numeric matrix. For `.h5ad` / 10x `.h5` inputs, see the scanpy
extension path below.

## Core pipeline (numpy/scipy)

```bash
python3 single_cell_rna_qc.py counts.csv \
  --output-metrics qc_metrics.json \
  --output-filtered counts.filtered.csv
```

What the script does, in order:

1. **Load** the counts matrix (cells x genes), detecting the gene column.
2. **QC metrics per cell**:
   - `total_counts` — total UMI/counts per cell
   - `n_genes` — number of detected genes (count > 0)
   - `pct_mito` — percentage of counts from mitochondrial genes
     (prefixes `MT-`/`mt-`/`MTRNR`, case-insensitive)
3. **Filter** — keep a cell when ALL hold:
   - `|log1p(total_counts) − median| ≤ n_mads × 1.4826 × MAD` (default 3 MAD)
   - same MAD rule on `n_genes`
   - `pct_mito ≤ max-pct-mito` (default 20%; pass `--max-pct-mito -1` to
     disable the mito cap)
4. **Report** — JSON summary with cells kept/removed and median metrics
   before/after (input vs. kept), plus the filtered counts CSV.

The MAD rule follows the scanpy/scverse convention (`sc.pp.filter_cells` +
outlier detection on log-transformed totals). The script never silently
changes the input: the original matrix is never overwritten, and the output
CSV is always a new file.

## Interpretation guardrails

- Report the JSON summary as-is; do not invent p-values or "quality grades".
- If `cells_removed` is extreme (>50%), say so and suggest checking the
  input for batch effects or multi-sample pooling before filtering harder.
- The mito cap is a **default**, not a law: for datasets where high mito is
  biologically expected (e.g. stressed or low-input samples), re-run with a
  higher cap or none, and state the choice in the response.
- Only the metrics you computed may appear in the report — no phantom
  doublet or ambient-RNA statistics.

## Scanpy extension path (optional)

When the user has `.h5ad` / 10x `.h5` files or wants embeddings/marker
workflows, and `scanpy` is installed, use the standard scverse workflow:
`sc.read_*` → `sc.pp.filter_cells` / `sc.pp.calculate_qc_metrics` (with
`var_names="mt-"` mito detection) → MAD outlier removal → `sc.pl.highly_variable_genes`
and QC violin plots. Verify scanpy availability first; if it is missing,
state that the CSV pipeline above remains available and never fabricate
scanpy output.

## Output conventions

Always end with a compact metrics block:

```text
QC SUMMARY
cells: <kept>/<input> (removed <n>)
median total_counts: <input> -> <kept>
median n_genes: <input> -> <kept>
median pct_mito: <input> -> <kept>
filter: <n_mads> MAD + mito cap <cap>%
filtered matrix: <path>
```

Include the JSON path and filtered CSV path in the reply so the user can
inspect them in the workspace.
