"""Python unit tests for the single-cell-rna-qc helper script.

Run with pytest from the repository root:

    uv run --project backend --extra science pytest skills/single-cell-rna-qc/tests/single_cell_rna_qc_test.py -q

Skips cleanly when numpy is unavailable. Uses a fixed random seed so the
synthetic counts matrix is deterministic.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

try:
    import numpy as np
except ImportError:
    np = None  # type: ignore[assignment]

SKILL_DIR = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_DIR / "single_cell_rna_qc.py"

pytestmark = pytest.mark.skipif(np is None, reason="numpy not installed")


def make_synthetic_counts(n_cells: int = 60, n_genes: int = 200, seed: int = 7) -> np.ndarray:
    """genes x cells counts matrix: mostly healthy cells plus 5 low-quality
    cells (very low total counts or very high mitochondrial fraction).
    Rows = genes, columns = cells; first 5 genes are mitochondrial markers."""
    rng = np.random.default_rng(seed)
    counts = rng.poisson(lam=3.0, size=(n_genes, n_cells)).astype(float)
    # Low-quality cells: last 3 columns get tiny counts, columns 3-4 get high mito.
    counts[:, -3:] = rng.poisson(lam=0.2, size=(n_genes, 3)).astype(float)
    counts[:5, 3] += 200.0
    counts[:5, 4] += 300.0
    return counts


def write_counts_csv(path: Path, counts: np.ndarray, mito_genes: int = 5) -> None:
    genes = [f"MT-gene{i}" if i < mito_genes else f"gene{i}" for i in range(counts.shape[0])]
    lines = ["gene," + ",".join(f"cell_{j}" for j in range(counts.shape[1]))]
    for g, row in zip(genes, counts):
        lines.append(g + "," + ",".join(f"{v:g}" for v in row))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_qc_metrics_computation(tmp_path: Path) -> None:
    counts = make_synthetic_counts()
    write_counts_csv(tmp_path / "counts.csv", counts)
    out = tmp_path / "metrics.json"
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(tmp_path / "counts.csv"), "--output-metrics", str(out)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    summary = json.loads(out.read_text(encoding="utf-8"))
    assert summary["n_cells_input"] == 60
    assert summary["n_genes_total"] == 200
    assert summary["mito_gene_count"] == 5
    assert 0 < summary["cells_removed"] < 10  # the 5 seeded low-quality cells


def read_filtered_counts(path: Path) -> np.ndarray:
    """Read the filtered genes x cells CSV (first column = gene id) into a matrix."""
    lines = path.read_text(encoding="utf-8").strip().splitlines()[1:]
    rows = [
        [float(v) for v in line.split(",")[1:]]
        for line in lines
        if line.strip()
    ]
    return np.asarray(rows, dtype=float)


def test_mad_filter_removes_seeded_low_quality_cells(tmp_path: Path) -> None:
    counts = make_synthetic_counts()
    write_counts_csv(tmp_path / "counts.csv", counts)
    out = tmp_path / "filtered.csv"
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(tmp_path / "counts.csv"), "--output-filtered", str(out)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    filtered = read_filtered_counts(out)
    # Seeded low-quality cells (3 degenerate + 2 high-mito) must be removed;
    # healthy cells stay. Allow MAD tolerance slack.
    assert filtered.shape[1] < 60
    assert filtered.shape[1] >= 50
    # Low-count cells must be gone: the three degenerate cells had tiny totals.
    kept_totals = filtered.sum(axis=0)
    assert kept_totals.min() > 5.0  # seeded low-quality cells had totals near 0-2


def test_mito_cap_disabled_keeps_more_cells(tmp_path: Path) -> None:
    counts = make_synthetic_counts()
    write_counts_csv(tmp_path / "counts.csv", counts)
    with_cap = tmp_path / "with_cap.json"
    no_cap = tmp_path / "no_cap.json"
    r1 = subprocess.run(
        [sys.executable, str(SCRIPT), str(tmp_path / "counts.csv"), "--output-metrics", str(with_cap)],
        capture_output=True, text=True,
    )
    r2 = subprocess.run(
        [sys.executable, str(SCRIPT), str(tmp_path / "counts.csv"), "--output-metrics", str(no_cap),
         "--max-pct-mito", "-1"],
        capture_output=True, text=True,
    )
    assert r1.returncode == 0 and r2.returncode == 0
    kept_with_cap = json.loads(with_cap.read_text(encoding="utf-8"))["cells_kept"]
    kept_no_cap = json.loads(no_cap.read_text(encoding="utf-8"))["cells_kept"]
    assert kept_no_cap >= kept_with_cap


def test_missing_input_returns_usage_error(tmp_path: Path) -> None:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(tmp_path / "does-not-exist.csv")],
        capture_output=True, text=True,
    )
    assert result.returncode == 2
    assert "not found" in result.stderr


def test_uppercase_mito_prefixes_are_detected(tmp_path: Path) -> None:
    """MT- and MTRNR gene names must count as mitochondrial regardless of case.

    Regression: prefixes were compared against lower-cased gene names without
    lower-casing the prefixes, so only the already-lower 'mt-' prefix worked.
    """
    genes = ["MT-ND1", "MTRNR2L12", "geneA", "geneB"]
    out = tmp_path / "counts.csv"
    lines = ["gene,c1,c2"] + [f"{g},5,5" for g in genes]
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(out), "--output-metrics", str(tmp_path / "m.json")],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    summary = json.loads((tmp_path / "m.json").read_text(encoding="utf-8"))
    assert summary["mito_gene_count"] == 2  # MT-ND1 + MTRNR2L12
    assert summary["median_pct_mito_input"] == 50.0  # 10 of 20 counts per cell


def test_all_cells_filtered_still_yields_valid_json(tmp_path: Path) -> None:
    """When every cell is removed the summary must stay strict JSON (no NaN)."""
    out = tmp_path / "m.json"
    # 0% mito cap on fully-mitochondrial cells removes every cell.
    mito_only = tmp_path / "mito.csv"
    lines = ["gene,c1,c2"] + ["MT-1,10,10", "MT-2,10,10", "geneA,1,1"]
    mito_only.write_text("\n".join(lines) + "\n", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(mito_only), "--output-metrics", str(out), "--max-pct-mito", "0"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    summary = json.loads(out.read_text(encoding="utf-8"))  # must parse as strict JSON
    assert summary["cells_kept"] == 0
    assert summary["median_total_counts_kept"] == 0.0


def test_malformed_rows_return_usage_error(tmp_path: Path) -> None:
    """Non-numeric cells must exit 2 (usage/input error), not traceback."""
    bad = tmp_path / "bad.csv"
    bad.write_text("gene,c1,c2\nMT-1,10,10\ngeneA,not-a-number,1\n", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(bad)],
        capture_output=True, text=True,
    )
    assert result.returncode == 2
    assert "invalid counts file" in result.stderr
    # Plain numeric matrix path (--no-gene-column) with garbage rows too.
    bad2 = tmp_path / "bad2.csv"
    bad2.write_text("1,2\n3,x\n", encoding="utf-8")
    result2 = subprocess.run(
        [sys.executable, str(SCRIPT), str(bad2), "--no-gene-column"],
        capture_output=True, text=True,
    )
    assert result2.returncode == 2
