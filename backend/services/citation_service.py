"""Citation normalization, deduplication, and conservative verification."""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timezone
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree

from models.citation import Citation


_DOI = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)?(10\.\d{4,9}/\S+)$", re.I)
_PMID = re.compile(r"^(?:https?://pubmed\.ncbi\.nlm\.nih\.gov/)?(\d+)(?:/)?$", re.I)
_ARXIV = re.compile(r"^(?:https?://arxiv\.org/(?:abs|pdf)/)?([0-9]{4}\.[0-9]{4,5})(?:v\d+)?(?:\.pdf)?$", re.I)
_MAX_CACHE = 1000
_VERIFICATION_CACHE: dict[tuple[str, str], Citation] = {}


def normalize_identifier(raw: str) -> Citation:
    value = str(raw or "").strip()
    if not value:
        raise ValueError("citation identifier is empty")
    match = _DOI.match(value.rstrip(".,;"))
    if match:
        identifier = match.group(1).rstrip(".,;\"").lower()
        return Citation(kind="doi", identifier=identifier, canonical=f"https://doi.org/{identifier}")
    match = _PMID.match(value.rstrip("/"))
    if match:
        identifier = match.group(1)
        return Citation(kind="pmid", identifier=identifier, canonical=f"https://pubmed.ncbi.nlm.nih.gov/{identifier}/")
    match = _ARXIV.match(value)
    if match:
        identifier = match.group(1)
        return Citation(kind="arxiv", identifier=identifier, canonical=f"https://arxiv.org/abs/{identifier}")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"unsupported citation identifier: {raw}")
    canonical = value.rstrip("/")
    return Citation(kind="url", identifier=canonical, canonical=canonical)


def deduplicate(citations: list[Citation]) -> list[Citation]:
    seen: dict[tuple[str, str], Citation] = {}
    for citation in citations:
        key = (citation.kind, citation.identifier.lower())
        current = seen.get(key)
        if current is None:
            seen[key] = citation
        else:
            # Preserve the most informative metadata while retaining the
            # original verification state unless the new record is stronger.
            if not current.title and citation.title:
                current.title = citation.title
            if not current.authors and citation.authors:
                current.authors = citation.authors
            if current.year is None and citation.year is not None:
                current.year = citation.year
            if current.verification == "unverified" and citation.verification != "unverified":
                current.verification = citation.verification
    return list(seen.values())


def _fetch(url: str, *, accept: str = "application/json") -> tuple[int, str, str]:
    request = Request(url, headers={"Accept": accept, "User-Agent": "pi-science/0.1"}, method="GET")
    with urlopen(request, timeout=15) as response:
        body = response.read(2 * 1024 * 1024).decode("utf-8", errors="replace")
        return int(getattr(response, "status", 200)), response.headers.get("content-type", ""), body


def _verify_doi(citation: Citation) -> Citation:
    try:
        encoded = quote(citation.identifier, safe="/")
        status, _content_type, body = _fetch(f"https://api.crossref.org/works/{encoded}")
        if status != 200:
            citation.verification = "not_found"
            citation.verification_detail = f"Crossref HTTP {status}"
            return citation
        payload = json.loads(body).get("message", {})
        citation.title = (payload.get("title") or [None])[0]
        citation.authors = [
            " ".join(part for part in (row.get("given"), row.get("family")) if part)
            for row in payload.get("author", [])
            if isinstance(row, dict)
        ]
        citation.year = ((payload.get("published-print") or payload.get("published-online") or payload.get("published") or {}).get("date-parts") or [[None]])[0][0]
        citation.source = "Crossref"
        citation.verification = "verified"
        citation.retrieved_at = datetime.now(timezone.utc)
        return citation
    except (OSError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
        citation.verification = "network_error"
        citation.verification_detail = str(exc)[:300]
        return citation


def _verify_pmid(citation: Citation) -> Citation:
    try:
        url = f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id={quote(citation.identifier)}&retmode=json"
        status, _content_type, body = _fetch(url)
        if status != 200:
            citation.verification = "not_found"
            citation.verification_detail = f"PubMed HTTP {status}"
            return citation
        record = json.loads(body).get("result", {}).get(citation.identifier)
        if not isinstance(record, dict) or not record.get("title"):
            citation.verification = "not_found"
            citation.verification_detail = "PubMed returned no record"
            return citation
        citation.title = record.get("title")
        citation.authors = [row.get("name") for row in record.get("authors", []) if isinstance(row, dict) and row.get("name")]
        pubdate = str(record.get("pubdate") or "")
        year = re.search(r"\b(19|20)\d{2}\b", pubdate)
        citation.year = int(year.group(0)) if year else None
        citation.source = "PubMed"
        citation.verification = "verified"
        citation.retrieved_at = datetime.now(timezone.utc)
        return citation
    except (OSError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
        citation.verification = "network_error"
        citation.verification_detail = str(exc)[:300]
        return citation


def _verify_arxiv(citation: Citation) -> Citation:
    try:
        status, _content_type, body = _fetch(
            f"https://export.arxiv.org/api/query?id_list={quote(citation.identifier)}",
            accept="application/atom+xml",
        )
        if status != 200:
            citation.verification = "not_found"
            citation.verification_detail = f"arXiv HTTP {status}"
            return citation
        root = ElementTree.fromstring(body)
        entry = next(iter(root.findall("{http://www.w3.org/2005/Atom}entry")), None)
        if entry is None:
            citation.verification = "not_found"
            citation.verification_detail = "arXiv returned no entry"
            return citation
        ns = "{http://www.w3.org/2005/Atom}"
        citation.title = (entry.findtext(f"{ns}title") or "").strip().replace("\n", " ")
        citation.authors = [
            (author.findtext(f"{ns}name") or "").strip()
            for author in entry.findall(f"{ns}author")
        ]
        published = entry.findtext(f"{ns}published") or ""
        year = re.match(r"(\d{4})", published)
        citation.year = int(year.group(1)) if year else None
        citation.source = "arXiv"
        citation.verification = "verified"
        citation.retrieved_at = datetime.now(timezone.utc)
        return citation
    except (OSError, TimeoutError, ValueError, ElementTree.ParseError) as exc:
        citation.verification = "network_error"
        citation.verification_detail = str(exc)[:300]
        return citation


def _verify_url(citation: Citation) -> Citation:
    try:
        status, _content_type, _body = _fetch(citation.canonical, accept="text/html,application/xhtml+xml")
        citation.verification = "verified" if 200 <= status < 400 else "not_found"
        citation.verification_detail = f"HTTP {status}"
        citation.source = urlparse(citation.canonical).netloc
        citation.retrieved_at = datetime.now(timezone.utc)
        return citation
    except (OSError, TimeoutError, ValueError) as exc:
        citation.verification = "network_error"
        citation.verification_detail = str(exc)[:300]
        return citation


async def verify(citation: Citation, *, force: bool = False) -> Citation:
    if citation.verification == "verified" and not force:
        return citation
    cache_key = (citation.kind, citation.identifier.lower())
    if not force and cache_key in _VERIFICATION_CACHE:
        return _VERIFICATION_CACHE[cache_key].model_copy(deep=True)
    func = {"doi": _verify_doi, "pmid": _verify_pmid, "arxiv": _verify_arxiv, "url": _verify_url}[citation.kind]
    result = await asyncio.to_thread(func, citation.model_copy(deep=True))
    if len(_VERIFICATION_CACHE) >= _MAX_CACHE:
        _VERIFICATION_CACHE.pop(next(iter(_VERIFICATION_CACHE)))
    _VERIFICATION_CACHE[cache_key] = result.model_copy(deep=True)
    return result
