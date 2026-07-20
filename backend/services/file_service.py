"""File service for reading/previewing workspace files."""

import base64
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

from models import FileContent, PreviewData
from services.preview_registry import EXT_TO_KIND, detect_preview_kind

logger = logging.getLogger(__name__)

MAX_TEXT_SIZE = 50 * 1024 * 1024
MAX_BINARY_PREVIEW_SIZE = 20 * 1024 * 1024


def resolve_workspace_path(workspace_dir: Path, path: str = ".") -> Path:
    """Resolve a path and reject traversal outside the workspace root.

    ``str.startswith`` is not sufficient here: ``/tmp/project-evil`` is not
    inside ``/tmp/project`` even though the string has the same prefix.
    ``Path.is_relative_to`` also handles the workspace root itself correctly.
    """
    root = workspace_dir.resolve()
    target = (root / path).resolve()
    if not target.is_relative_to(root):
        raise ValueError(f"Path outside workspace: {path}")
    return target

def read_file_content(workspace_dir: Path, path: str, encoding: str = "utf8") -> FileContent:
    """Read a file from the workspace."""
    full_path = resolve_workspace_path(workspace_dir, path)

    if not full_path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    if not full_path.is_file():
        raise ValueError(f"Not a file: {path}")

    size = full_path.stat().st_size
    if size > MAX_TEXT_SIZE:
        raise ValueError(
            f"File too large to read ({size} bytes). Use /api/files/probe for structure."
        )

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
    full_path = resolve_workspace_path(workspace_dir, path)

    if not full_path.exists():
        raise FileNotFoundError(f"File not found: {path}")
    if not full_path.is_file():
        raise ValueError(f"Not a file: {path}")

    kind = detect_preview_kind(path)
    preview = PreviewData(kind=kind, filename=Path(path).name)

    if kind in {"fits", "netcdf", "mesh", "image", "pdf"}:
        size = full_path.stat().st_size
        if size > MAX_BINARY_PREVIEW_SIZE:
            preview.text = (
                f"[File too large to preview ({size} bytes). "
                "Use /api/files/probe for structure.]"
            )
            preview.metadata = {"size": size, "truncated": True}
            return preview

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
            logger.debug("Failed to read %s file: %s", kind, full_path, exc_info=True)
            preview.text = f"[Error reading {kind} file]"

    elif kind == "fits":
        try:
            raw = full_path.read_bytes()
            preview.data = base64.b64encode(raw).decode("ascii")
            preview.metadata = {"size": len(raw)}
        except Exception:
            logger.debug("Failed to read FITS file: %s", full_path, exc_info=True)
            preview.text = "[Error reading FITS file]"

    elif kind == "netcdf":
        try:
            raw = full_path.read_bytes()
            preview.data = base64.b64encode(raw).decode("ascii")
            preview.metadata = {"size": len(raw)}
        except Exception:
            logger.debug("Failed to read NetCDF/HDF5 file: %s", full_path, exc_info=True)
            preview.text = "[Error reading NetCDF/HDF5 file]"

    elif kind == "molecule":
        try:
            preview.text = full_path.read_text(encoding="utf-8")
        except Exception:
            logger.debug("Failed to read molecule file: %s", full_path, exc_info=True)
            preview.text = "[Error reading molecule file]"

    elif kind == "mesh":
        try:
            raw = full_path.read_bytes()
            preview.data = base64.b64encode(raw).decode("ascii")
            preview.metadata = {"size": len(raw)}
        except Exception:
            logger.debug("Failed to read mesh file: %s", full_path, exc_info=True)
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
            logger.debug("Failed to read %s file: %s", kind, full_path, exc_info=True)
            preview.text = f"[Error reading {kind} file]"

    else:
        # Default: try text
        try:
            preview.text = full_path.read_text(encoding="utf-8")[:50000]
        except Exception:
            logger.debug("Cannot preview %s file: %s", kind, full_path, exc_info=True)
            preview.text = f"[Cannot preview: {kind}]"

    return preview
