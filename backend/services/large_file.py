"""Large file probing — peek at file structure without loading the whole thing."""

import csv
import json
import struct
from pathlib import Path
from typing import Any


def probe_file(filepath: Path) -> dict[str, Any]:
    """Probe a file and return its structure summary. Never loads more than 1MB."""
    if not filepath.exists():
        return {"error": "File not found", "size_bytes": 0}

    size = filepath.stat().st_size
    ext = filepath.suffix.lower()
    result: dict[str, Any] = {
        "format": ext.lstrip(".") or "unknown",
        "size_bytes": size,
        "size": _human_size(size),
    }

    if size > 100 * 1024 * 1024:  # > 100MB
        result["note"] = "File is very large. Consider using command-line tools to inspect."
        return result

    try:
        if ext in (".csv", ".tsv"):
            _probe_csv(filepath, result)
        elif ext in (".json", ".jsonl"):
            _probe_json(filepath, result)
        elif ext in (".nc", ".nc4", ".h5", ".hdf5"):
            _probe_hdf5(filepath, result)
        elif ext in (".fits", ".fit"):
            _probe_fits(filepath, result)
        elif ext in (".parquet"):
            _probe_parquet(filepath, result)
        elif ext in (".bed", ".gff", ".gtf", ".vcf"):
            _probe_genomics(filepath, result, ext)
        elif ext in (".stl", ".obj", ".ply"):
            _probe_mesh(filepath, result, ext)
        else:
            _probe_text(filepath, result)
    except Exception as e:
        result["note"] = str(e)

    return result


def _human_size(b: int) -> str:
    if b < 1024:
        return f"{b} B"
    if b < 1_048_576:
        return f"{b/1024:.1f} KB"
    if b < 1_073_741_824:
        return f"{b/1_048_576:.1f} MB"
    return f"{b/1_073_741_824:.1f} GB"


def _probe_csv(filepath: Path, r: dict):
    enc = "utf-8" if filepath.suffix == ".csv" else "utf-8"
    with open(filepath, encoding=enc, errors="replace") as f:
        reader = csv.reader(f, delimiter="\t" if filepath.suffix == ".tsv" else ",")
        header = next(reader)
        r["columns"] = [{"name": h, "dtype": "unknown"} for h in header]
        r["n_columns"] = len(header)
        rows = 0
        sample = []
        for row in reader:
            rows += 1
            if len(sample) < 5:
                sample.append(row)
            if rows >= 10000:
                break
        r["rows"] = rows
        r["sample"] = sample


def _probe_json(filepath: Path, r: dict):
    with open(filepath) as f:
        first = f.readline(1024 * 1024)
    if first.strip().startswith("{"):
        try:
            d = json.loads(first)
            r["top_keys"] = list(d.keys())[:20]
            r["n_top_keys"] = len(d)
        except Exception:
            r["note"] = "Invalid JSON"
    elif first.strip().startswith("["):
        lines = first.strip().split("\n")
        r["lines"] = len(lines)
        if lines:
            try:
                item = json.loads(lines[0])
                r["first_item_keys"] = list(item.keys())[:10] if isinstance(item, dict) else ["(array)"]
            except Exception:
                pass


def _probe_hdf5(filepath: Path, r: dict):
    try:
        import h5py
        with h5py.File(filepath, "r") as f:
            datasets = []
            def visitor(name, obj):
                if isinstance(obj, h5py.Dataset):
                    datasets.append({"path": name, "shape": list(obj.shape), "dtype": str(obj.dtype)})
            f.visititems(visitor)
            r["datasets"] = datasets[:20]
            r["n_datasets"] = len(datasets)
            r["format"] = "hdf5"
    except ImportError:
        r["note"] = "h5py not installed"


def _probe_fits(filepath: Path, r: dict):
    r["format"] = "fits"
    try:
        with open(filepath, "rb") as f:
            header = f.read(2880)
            keys = []
            for i in range(0, 2880, 80):
                card = header[i:i+80].decode("ascii", errors="replace").strip()
                if card and card != "END" * 3:
                    keys.append(card[:60])
            r["header_keys"] = [k.split("=")[0].strip() for k in keys if "=" in k][:20]
            r["n_header_keys"] = len(keys)
    except Exception:
        r["note"] = "Cannot read FITS header"


def _probe_parquet(filepath: Path, r: dict):
    try:
        import pyarrow.parquet as pq
        pf = pq.ParquetFile(filepath)
        r["columns"] = [{"name": c, "dtype": str(pf.schema_arrow.field(c).type)} for c in pf.schema.names]
        r["n_columns"] = len(pf.schema.names)
        r["n_rows"] = pf.metadata.num_rows
        r["format"] = "parquet"
    except ImportError:
        r["note"] = "pyarrow not installed"


def _probe_genomics(filepath: Path, r: dict, ext: str):
    r["format"] = ext.lstrip(".")
    with open(filepath) as f:
        lines = 0
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            lines += 1
            if lines >= 50000:
                break
        r["lines"] = lines
        r["note"] = f"{lines} non-comment lines (capped at 50k)" if lines >= 50000 else None


def _probe_mesh(filepath: Path, r: dict, ext: str):
    r["format"] = ext.lstrip(".")
    r["size"] = _human_size(filepath.stat().st_size)
    if ext == ".stl":
        with open(filepath, "rb") as f:
            f.read(80)
            count = struct.unpack("<I", f.read(4))[0]
            r["triangles"] = count
            r["format"] = "stl"
    elif ext == ".obj":
        with open(filepath, errors="replace") as f:
            verts = (
                sum(1 for line in f if line.startswith("v "))
                if filepath.stat().st_size < 50_000_000
                else "large"
            )
            r["vertices"] = verts
            r["format"] = "obj"
    elif ext == ".ply":
        with open(filepath, errors="replace") as f:
            header_end = False
            for line in f:
                if "end_header" in line:
                    header_end = True
                    break
                if line.startswith("element vertex"):
                    r["vertices"] = int(line.split()[-1])
                elif line.startswith("element face"):
                    r["faces"] = int(line.split()[-1])
            if not header_end:
                r["note"] = "Could not parse PLY header"
            r["format"] = "ply"


def _probe_text(filepath: Path, r: dict):
    r["format"] = "text"
    try:
        with open(filepath, errors="replace") as f:
            r["lines"] = sum(1 for _ in f) if filepath.stat().st_size < 10_000_000 else "large"
    except Exception:
        pass
