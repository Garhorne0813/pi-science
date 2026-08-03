#!/usr/bin/env python3
"""Single-cell RNA-seq QC helper for the single-cell-rna-qc skill.

Computes per-cell QC metrics (total counts, detected genes, mitochondrial
percentage) from a counts matrix and applies median-absolute-deviation (MAD)
based filtering, following scverse/scanpy conventions without requiring
scanpy itself. Core logic is numpy/scipy only; scanpy is an optional upgrade
path documented in SKILL.md.

Input:  a CSV of raw counts, rows = genes and columns = cells, with a gene
        identifier first column — or a plain numeric matrix CSV (rows =
        genes, columns = cells) when --no-gene-column is passed.
Output: per-cell QC metrics JSON and the filtered counts matrix CSV.

Exit codes: 0 success, 2 usage/input error, 3 dependency missing.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import numpy as np
except ImportError as exc:  # pragma: no cover - depends on environment
    sys.stderr.write(
        f"single_cell_rna_qc: missing dependency ({exc}). "
        "Install with: uv pip install numpy\n"
    )
    sys.exit(3)

MITO_PREFIXES = ("MT-", "mt-", "MTRNR")


def load_counts(path: Path, no_gene_column: bool) -> tuple[np.ndarray, list[str] | None]:
    """Load a counts CSV into a genes x cells matrix.

    Returns (matrix, gene_names). gene_names is None when the file is a plain
    numeric matrix and --no-gene-column was passed.
    """
    with path.open("r", encoding="utf-8") as handle:
        header = handle.readline().strip().split(",")
    has_gene_col = bool(header) and header[0].strip().lower() in ("gene", "genes", "symbol", "feature")
    if no_gene_column or not has_gene_col:
        matrix = np.loadtxt(path, delimiter=",", ndmin=2, dtype=float)
        return matrix, None
    # Gene column present: first column holds gene ids, remaining are cells.
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    gene_names: list[str] = []
    rows: list[list[float]] = []
    for line in lines[1:]:
        parts = line.split(",")
        gene_names.append(parts[0])
        rows.append([float(v) for v in parts[1:]])
    matrix = np.asarray(rows, dtype=float)
    if matrix.ndim == 1:  # single gene edge case
        matrix = matrix.reshape(1, -1)
    return matrix, gene_names


def compute_qc_metrics(counts: np.ndarray, gene_names: list[str] | None, mito_prefixes: tuple[str, ...] = MITO_PREFIXES) -> dict:
    """Per-cell QC metrics from a genes x cells counts matrix.

    Rows are genes (optionally with names in gene_names), columns are cells.
    """
    counts = np.asarray(counts, dtype=float)
    total_counts = counts.sum(axis=0)
    n_genes = (counts > 0).sum(axis=0)
    mito_mask = np.zeros(counts.shape[0], dtype=bool)
    if gene_names is not None:
        lower = [g.lower() for g in gene_names]
        mito_mask = np.asarray(
            [any(g.startswith(p.lower()) for p in mito_prefixes) for g in lower], dtype=bool
        )
    mito_counts = counts[mito_mask, :].sum(axis=0) if mito_mask.any() else np.zeros(counts.shape[1])
    with np.errstate(divide="ignore", invalid="ignore"):
        pct_mito = np.where(total_counts > 0, 100.0 * mito_counts / np.maximum(total_counts, 1), 0.0)
    return {
        "total_counts": total_counts,
        "n_genes": n_genes,
        "pct_mito": pct_mito,
        "n_cells": int(counts.shape[1]),
        "n_genes_total": int(counts.shape[0]),
        "mito_gene_count": int(mito_mask.sum()),
    }


def mad_filter(values: np.ndarray, n_mads: float = 3.0) -> np.ndarray:
    """Boolean keep-mask using median absolute deviation (scanpy-style)."""
    values = np.asarray(values, dtype=float)
    median = np.median(values)
    mad = float(np.median(np.abs(values - median))) if values.size else 0.0
    if mad == 0.0:
        # Degenerate case (all identical): keep everything.
        return np.ones(values.shape, dtype=bool)
    return np.abs(values - median) <= n_mads * 1.4826 * mad


def filter_cells(counts: np.ndarray, metrics: dict, n_mads: float = 3.0, max_pct_mito: float | None = 20.0) -> np.ndarray:
    """Combined keep-mask: MAD on log total counts and n_genes, optional mito cap."""
    with np.errstate(divide="ignore", invalid="ignore"):
        log_total = np.log1p(metrics["total_counts"])
    keep = mad_filter(log_total, n_mads) & mad_filter(metrics["n_genes"], n_mads)
    if max_pct_mito is not None:
        keep = keep & (metrics["pct_mito"] <= max_pct_mito)
    return keep


def _safe_median(values: np.ndarray) -> float:
    """Median of a possibly-empty array; 0.0 for empty (keeps output strict JSON)."""
    return float(np.median(values)) if values.size else 0.0


def to_serializable(metrics: dict, keep: np.ndarray) -> dict:
    """Metrics dict -> plain JSON-serializable dict (filtered summary only)."""
    total = metrics["total_counts"]
    genes = metrics["n_genes"]
    mito = metrics["pct_mito"]
    return {
        "n_cells_input": metrics["n_cells"],
        "n_genes_total": metrics["n_genes_total"],
        "mito_gene_count": metrics["mito_gene_count"],
        "cells_kept": int(keep.sum()),
        "cells_removed": int((~keep).sum()),
        "median_total_counts_input": _safe_median(total),
        "median_total_counts_kept": _safe_median(total[keep]),
        "median_n_genes_input": _safe_median(genes),
        "median_n_genes_kept": _safe_median(genes[keep]),
        "median_pct_mito_input": _safe_median(mito),
        "median_pct_mito_kept": _safe_median(mito[keep]),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path, help="counts CSV (rows = genes, columns = cells), with a gene-id first column")
    parser.add_argument("--output-metrics", type=Path, default=None, help="JSON file for QC metric summary (default: stdout)")
    parser.add_argument("--output-filtered", type=Path, default=None, help="filtered counts CSV output (default: <input>.filtered.csv)")
    parser.add_argument("--n-mads", type=float, default=3.0, help="MAD threshold (default: 3.0)")
    parser.add_argument("--max-pct-mito", type=float, default=20.0, help="mitochondrial percentage cap (default: 20, use -1 to disable)")
    parser.add_argument("--no-gene-column", action="store_true", help="treat input as a plain numeric matrix (rows = genes, columns = cells)")
    args = parser.parse_args(argv)

    if not args.input.is_file():
        sys.stderr.write(f"single_cell_rna_qc: input not found: {args.input}\n")
        return 2

    try:
        counts, gene_names = load_counts(args.input, args.no_gene_column)
    except (ValueError, IndexError) as exc:
        sys.stderr.write(f"single_cell_rna_qc: invalid counts file: {exc}\n")
        return 2
    if counts.size == 0:
        sys.stderr.write("single_cell_rna_qc: empty counts matrix\n")
        return 2

    metrics = compute_qc_metrics(counts, gene_names)
    max_mito = None if args.max_pct_mito < 0 else args.max_pct_mito
    keep = filter_cells(counts, metrics, n_mads=args.n_mads, max_pct_mito=max_mito)
    summary = to_serializable(metrics, keep)

    out_metrics = args.output_metrics
    if out_metrics is not None:
        out_metrics.write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    else:
        print(json.dumps(summary, indent=2, allow_nan=False))

    out_filtered = args.output_filtered or args.input.with_suffix(args.input.suffix + ".filtered.csv")
    filtered = counts[:, keep]
    if gene_names is not None:
        header = ["gene"] + [f"cell_{i}" for i in range(filtered.shape[1])]
        lines = [",".join(header)]
        for g, row in zip(gene_names, filtered):
            lines.append(",".join([g] + [f"{v:g}" for v in row]))
        out_filtered.write_text("\n".join(lines) + "\n", encoding="utf-8")
    else:
        np.savetxt(out_filtered, filtered, delimiter=",", fmt="%g")
    return 0


if __name__ == "__main__":
    sys.exit(main())
