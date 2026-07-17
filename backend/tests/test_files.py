"""File API tests."""

import pytest
from services.file_service import (
    detect_preview_kind,
    read_file_content,
    resolve_workspace_path,
    EXT_TO_KIND,
)


class TestDetectPreviewKind:
    def test_csv(self):
        assert detect_preview_kind("data.csv") == "csv"

    def test_tsv(self):
        assert detect_preview_kind("data.tsv") == "tsv"

    def test_fits(self):
        assert detect_preview_kind("image.fits") == "fits"
        assert detect_preview_kind("image.fit") == "fits"

    def test_netcdf_hdf5(self):
        assert detect_preview_kind("data.nc") == "netcdf"
        assert detect_preview_kind("data.h5") == "netcdf"
        assert detect_preview_kind("data.hdf5") == "netcdf"

    def test_molecule_formats(self):
        assert detect_preview_kind("mol.pdb") == "molecule"
        assert detect_preview_kind("mol.cif") == "molecule"
        assert detect_preview_kind("mol.sdf") == "molecule"
        assert detect_preview_kind("mol.smi") == "molecule"
        assert detect_preview_kind("mol.xyz") == "molecule"

    def test_mesh_formats(self):
        assert detect_preview_kind("model.obj") == "mesh"
        assert detect_preview_kind("model.stl") == "mesh"
        assert detect_preview_kind("model.glb") == "mesh"

    def test_genome_formats(self):
        assert detect_preview_kind("data.vcf") == "genome"
        assert detect_preview_kind("data.bed") == "genome"
        assert detect_preview_kind("data.gff") == "genome"
        assert detect_preview_kind("data.gtf") == "genome"

    def test_image_formats(self):
        assert detect_preview_kind("photo.png") == "image"
        assert detect_preview_kind("photo.jpg") == "image"
        assert detect_preview_kind("photo.svg") == "image"

    def test_pdf(self):
        assert detect_preview_kind("doc.pdf") == "pdf"

    def test_office_formats(self):
        assert detect_preview_kind("doc.docx") == "office"
        assert detect_preview_kind("doc.xlsx") == "office"
        assert detect_preview_kind("doc.pptx") == "office"

    def test_markdown(self):
        assert detect_preview_kind("readme.md") == "markdown"

    def test_code_text(self):
        assert detect_preview_kind("script.py") == "text"
        assert detect_preview_kind("script.r") == "text"
        assert detect_preview_kind("config.json") == "text"

    def test_unknown_extension(self):
        assert detect_preview_kind("file.unknown") == "text"

    def test_case_insensitive(self):
        assert detect_preview_kind("IMAGE.PNG") == "image"
        assert detect_preview_kind("Image.Jpg") == "image"


class TestReadFileContent:
    def test_read_text_file(self, temp_csv):
        content = read_file_content(temp_csv.parent, "test.csv")
        assert content.encoding == "utf8"
        assert content.path == "test.csv"
        assert "alpha" in content.data
        assert content.size > 0

    def test_file_not_found(self, temp_workspace):
        with pytest.raises(FileNotFoundError):
            read_file_content(temp_workspace, "nonexistent.txt")

    def test_path_outside_workspace(self, temp_workspace):
        with pytest.raises(ValueError, match="outside workspace"):
            read_file_content(temp_workspace, "../outside.txt")

    def test_path_prefix_sibling_is_outside_workspace(self, temp_workspace):
        """A sibling whose name shares the workspace prefix is not inside it."""
        sibling = temp_workspace.parent / f"{temp_workspace.name}-evil"
        with pytest.raises(ValueError, match="outside workspace"):
            resolve_workspace_path(temp_workspace, f"../{sibling.name}/secret.txt")


class TestExtToKind:
    def test_all_registered_extensions(self):
        """Every registered extension maps to a non-empty kind."""
        for ext, kind in EXT_TO_KIND.items():
            assert kind, f"Extension .{ext} maps to empty kind"
            assert isinstance(kind, str), f"Extension .{ext} maps to non-string"


@pytest.mark.anyio
class TestFilesAPI:
    async def test_read_csv_file(self, client, temp_csv):
        """GET /api/files reads a CSV file."""
        cwd = str(temp_csv.parent)
        res = await client.get(f"/api/files/test.csv?cwd={cwd}")
        assert res.status_code == 200
        data = res.json()
        assert data["path"] == "test.csv"
        assert data["encoding"] == "utf8"
        assert "alpha" in data["data"]

    async def test_read_csv_base64(self, client, temp_csv):
        """GET /api/files with format=base64."""
        cwd = str(temp_csv.parent)
        res = await client.get(f"/api/files/test.csv?cwd={cwd}&format=base64")
        assert res.status_code == 200
        data = res.json()
        assert data["encoding"] == "base64"

    async def test_file_not_found_404(self, client, temp_workspace):
        cwd = str(temp_workspace)
        res = await client.get(f"/api/files/nonexistent.txt?cwd={cwd}")
        assert res.status_code == 404

    async def test_raw_file(self, client, temp_csv):
        """GET /api/files/{path}/raw serves the file directly."""
        cwd = str(temp_csv.parent)
        res = await client.get(f"/api/files/test.csv/raw?cwd={cwd}")
        assert res.status_code == 200
        assert "alpha" in res.text

    async def test_preview_csv(self, client, temp_csv):
        """GET /api/files/{path}/preview returns preview data."""
        cwd = str(temp_csv.parent)
        res = await client.get(f"/api/files/test.csv/preview?cwd={cwd}")
        assert res.status_code == 200
        data = res.json()
        assert data["kind"] == "csv"
        assert data["filename"] == "test.csv"
        assert data["metadata"]["rows"] == 3
        assert data["metadata"]["columns"] == 3

    async def test_preview_missing_file_404(self, client, temp_workspace):
        cwd = str(temp_workspace)
        res = await client.get(f"/api/files/missing.csv/preview?cwd={cwd}")
        assert res.status_code == 404

    async def test_upload_uses_requested_workspace(self, client, temp_workspace):
        res = await client.post(
            f"/api/files/upload?cwd={temp_workspace}",
            files={"file": ("uploaded.txt", b"hello", "text/plain")},
        )
        assert res.status_code == 200
        assert (temp_workspace / "uploaded.txt").read_text() == "hello"

    async def test_list_rejects_sibling_prefix_traversal(self, client, temp_workspace):
        sibling = temp_workspace.parent / f"{temp_workspace.name}-evil"
        res = await client.get(
            f"/api/files?cwd={temp_workspace}&subdir=../{sibling.name}"
        )
        assert res.status_code == 403
