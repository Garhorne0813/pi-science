"""Scientific file preview registry."""

from pathlib import Path


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
    ".xlsm": "office",
    ".xltx": "office",
    ".docx": "office",
    ".docm": "office",
    ".dotx": "office",
    ".pptx": "office",
    ".pptm": "office",
    ".potx": "office",
}


def detect_preview_kind(path: str) -> str:
    """Detect the preview kind from file extension."""
    ext = Path(path).suffix.lower()
    return EXT_TO_KIND.get(ext, "text")
