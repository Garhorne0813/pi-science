"""Persistent page-level PDF text index for multi-page evidence workflows."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from services.workspace_security import resolve_workspace_file


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _extract_pages(path: Path) -> list[str]:
    try:
        from pypdf import PdfReader

        return [(page.extract_text() or "") for page in PdfReader(str(path)).pages]
    except Exception as exc:
        raise ValueError(f"unable to parse PDF: {exc}") from exc


class PdfIndex:
    def __init__(self, workspace: str):
        self.workspace = Path(workspace).expanduser().resolve()
        self.directory = self.workspace / ".pi-science" / "pdf-index"
        self.directory.mkdir(parents=True, exist_ok=True)

    async def index(self, path: str) -> dict[str, Any]:
        file_path = resolve_workspace_file(self.workspace, path)
        if not file_path.exists() or not file_path.is_file():
            raise FileNotFoundError(path)
        if file_path.suffix.lower() != ".pdf":
            raise ValueError("PDF index requires a .pdf file")
        digest = _sha256(file_path)
        cache_path = self.directory / f"{digest}.json"
        if cache_path.exists():
            try:
                return json.loads(cache_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                pass
        pages = _extract_pages(file_path)
        payload = {
            "path": file_path.relative_to(self.workspace).as_posix(),
            "sha256": digest,
            "page_count": len(pages),
            "pages": [{"page": index + 1, "text": text[:500_000]} for index, text in enumerate(pages)],
            "ocr_required": bool(pages) and not any(text.strip() for text in pages),
        }
        cache_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return payload

    async def search(self, path: str, query: str, *, limit: int = 20) -> list[dict[str, Any]]:
        if not query.strip():
            raise ValueError("query is required")
        payload = await self.index(path)
        terms = [term.lower() for term in re.findall(r"\w+", query) if term]
        results: list[dict[str, Any]] = []
        for page in payload["pages"]:
            text = page["text"]
            lowered = text.lower()
            if all(term in lowered for term in terms):
                position = min((lowered.find(term) for term in terms if lowered.find(term) >= 0), default=0)
                start = max(0, position - 180)
                results.append({"page": page["page"], "snippet": text[start:start + 600]})
        return results[:limit]


_indexes: dict[str, PdfIndex] = {}


def get_pdf_index(workspace: str) -> PdfIndex:
    key = str(Path(workspace).expanduser().resolve())
    if key not in _indexes:
        _indexes[key] = PdfIndex(key)
    return _indexes[key]
