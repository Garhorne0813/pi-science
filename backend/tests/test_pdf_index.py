"""Persistent PDF page index tests."""

import pytest

from services import pdf_index
from services.pdf_index import PdfIndex


@pytest.mark.anyio
async def test_pdf_index_is_cached_by_content_hash(temp_workspace, monkeypatch):
    pdf = temp_workspace / "paper.pdf"
    pdf.write_bytes(b"fake-pdf")
    calls = {"count": 0}

    def fake_extract(path):
        calls["count"] += 1
        return ["Introduction\nresult one", "Methods\nresult two"]

    monkeypatch.setattr(pdf_index, "_extract_pages", fake_extract)
    index = PdfIndex(str(temp_workspace))
    first = await index.index("paper.pdf")
    second = await index.index("paper.pdf")
    assert first["page_count"] == 2
    assert calls["count"] == 1
    assert (await index.search("paper.pdf", "result two"))[0]["page"] == 2
    assert second["sha256"] == first["sha256"]


@pytest.mark.anyio
async def test_pdf_index_rejects_non_pdf(temp_workspace):
    (temp_workspace / "notes.txt").write_text("text")
    with pytest.raises(ValueError):
        await PdfIndex(str(temp_workspace)).index("notes.txt")


@pytest.mark.anyio
async def test_pdf_api_index_and_search(client, temp_workspace, monkeypatch):
    pdf = temp_workspace / "paper.pdf"
    pdf.write_bytes(b"fake-pdf")
    monkeypatch.setattr(pdf_index, "_extract_pages", lambda _path: ["A finding"])
    cwd = str(temp_workspace)
    indexed = await client.post(f"/api/pdfs/index?cwd={cwd}&path=paper.pdf")
    assert indexed.status_code == 200
    searched = await client.post(f"/api/pdfs/search?cwd={cwd}", json={"path": "paper.pdf", "query": "finding"})
    assert searched.status_code == 200
    assert searched.json()["results"][0]["page"] == 1

