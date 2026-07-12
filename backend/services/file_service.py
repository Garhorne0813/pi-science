"""File service for reading/previewing workspace files."""

import base64
import json
from pathlib import Path
from typing import Optional

from models import FileContent, PreviewData

# Common scientific file extension -> preview kind mapping
EXT_TO_KIND: dict[str, str] = {
    ".fits": "fits",
    ".fit": "fits",
    ".nc": "netcdf",
    ".nc4": "netcdf",
    ".h5": "netcdf",
    ".hdf5": "netcdf",
    ".csv": "csv",
    ".tsv": "tsv",
    ".pdb": "molecule",
    ".cif": "molecule",
    ".mol": "molecule",
    ".mol2": "molecule",
    ".sdf": "molecule",
    ".smi": "molecule",
    ".xyz": "molecule",
    ".obj": "mesh",
    ".stl": "mesh",
    ".ply": "mesh",
    ".glb": "mesh",
    ".gltf": "mesh",
    ".vcf": "genome",
    ".bed": "genome",
    ".gff": "genome",
    ".gtf": "genome",
    ".bam": "genome",
    ".pdf": "pdf",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".gif": "image",
    ".svg": "image",
    ".tiff": "image",
    ".tif": "image",
    ".md": "markdown",
    ".html": "html",
    ".json": "text",
    ".txt": "text",
    ".py": "text",
    ".r": "text",
    ".sh": "text",
    ".ipynb": "notebook",
    ".xlsx": "office",
    ".xls": "office",
    ".docx": "office",
    ".pptx": "office",
}


def detect_preview_kind(path: str) -> str:
    """Detect the preview kind from file extension."""
    ext = Path(path).suffix.lower()
    return EXT_TO_KIND.get(ext, "text")


def read_file_content(workspace_dir: Path, path: str, encoding: str = "utf8") -> FileContent:
    """Read a file from the workspace."""
    full_path = (workspace_dir / path).resolve()

    # Safety: ensure file is within workspace
    if not str(full_path).startswith(str(workspace_dir.resolve())):
        raise ValueError(f"Path outside workspace: {path}")

    if not full_path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    if not full_path.is_file():
        raise ValueError(f"Not a file: {path}")

    try:
        text = full_path.read_text(encoding="utf-8")
        return FileContent(
            path=path,
            encoding="utf8",
            data=text,
            size=len(text.encode("utf-8")),
        )
    except UnicodeDecodeError:
        # Binary file, return as base64
        raw = full_path.read_bytes()
        return FileContent(
            path=path,
            encoding="base64",
            data=base64.b64encode(raw).decode("ascii"),
            size=len(raw),
        )


def get_preview_data(workspace_dir: Path, path: str) -> PreviewData:
    """Get preview data for a scientific file."""
    full_path = (workspace_dir / path).resolve()
    if not str(full_path).startswith(str(workspace_dir.resolve())):
        raise ValueError(f"Path outside workspace: {path}")

    kind = detect_preview_kind(path)
    preview = PreviewData(kind=kind, filename=Path(path).name)

    if kind in ("csv", "tsv"):
        try:
            text = full_path.read_text(encoding="utf-8")
            preview.text = text[:100000]  # Cap at 100KB
            # Basic metadata
            lines = text.strip().split("\n")
            preview.metadata = {
                "rows": len(lines) - 1,
                "columns": len(lines[0].split("\t" if kind == "tsv" else ",")) if lines else 0,
            }
        except Exception:
            preview.text = f"[Error reading {kind} file]"

    elif kind == "fits":
        try:
            raw = full_path.read_bytes()
            preview.data = base64.b64encode(raw).decode("ascii")
            preview.metadata = {"size": len(raw)}
        except Exception:
            preview.text = "[Error reading FITS file]"

    elif kind == "netcdf":
        try:
            raw = full_path.read_bytes()
            preview.data = base64.b64encode(raw).decode("ascii")
            preview.metadata = {"size": len(raw)}
        except Exception:
            preview.text = "[Error reading NetCDF/HDF5 file]"

    elif kind == "molecule":
        try:
            preview.text = full_path.read_text(encoding="utf-8")
        except Exception:
            preview.text = "[Error reading molecule file]"

    elif kind == "mesh":
        try:
            raw = full_path.read_bytes()
            preview.data = base64.b64encode(raw).decode("ascii")
            preview.metadata = {"size": len(raw)}
        except Exception:
            preview.text = "[Error reading mesh file]"

    elif kind in ("image", "pdf"):
        try:
            raw = full_path.read_bytes()
            preview.data = base64.b64encode(raw).decode("ascii")
            preview.metadata = {
                "size": len(raw),
                "mime_type": f"image/{kind}" if kind != "pdf" else "application/pdf",
            }
        except Exception:
            preview.text = f"[Error reading {kind} file]"

    else:
        # Default: try text
        try:
            preview.text = full_path.read_text(encoding="utf-8")[:50000]
        except Exception:
            preview.text = f"[Cannot preview: {kind}]"

    return preview
