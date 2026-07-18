"""Read-only literature provider adapters with normalized results."""

from __future__ import annotations

import asyncio
import json
from urllib.parse import quote
from urllib.request import Request, urlopen
from xml.etree import ElementTree

from models.literature import LiteratureRecord


def _fetch_json(url: str) -> dict:
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "pi-science/0.1"}, method="GET")
    with urlopen(request, timeout=15) as response:
        return json.loads(response.read(5 * 1024 * 1024).decode("utf-8"))


def _crossref(query: str, limit: int) -> list[LiteratureRecord]:
    payload = _fetch_json(f"https://api.crossref.org/works?query={quote(query)}&rows={limit}")
    rows = payload.get("message", {}).get("items", [])
    return [LiteratureRecord(
        title=(row.get("title") or ["Untitled"])[0],
        authors=[" ".join(part for part in (item.get("given"), item.get("family")) if part) for item in row.get("author", []) if isinstance(item, dict)],
        year=((row.get("published-print") or row.get("published-online") or row.get("published") or {}).get("date-parts") or [[None]])[0][0],
        identifier=row.get("DOI"), identifier_kind="doi", url=f"https://doi.org/{row['DOI']}" if row.get("DOI") else None,
        source="Crossref",
    ) for row in rows if isinstance(row, dict)]


def _openalex(query: str, limit: int) -> list[LiteratureRecord]:
    payload = _fetch_json(f"https://api.openalex.org/works?search={quote(query)}&per-page={limit}")
    result = []
    for row in payload.get("results", []):
        doi = str(row.get("doi") or "").removeprefix("https://doi.org/") or None
        result.append(LiteratureRecord(
            title=row.get("title") or "Untitled",
            authors=[(((item.get("author") or {}).get("display_name")) or "") for item in row.get("authorships", []) if isinstance(item, dict) and item.get("author")],
            year=row.get("publication_year"), identifier=doi, identifier_kind="doi" if doi else None,
            url=row.get("primary_location", {}).get("landing_page_url") if isinstance(row.get("primary_location"), dict) else None,
            source="OpenAlex",
        ))
    return result


def _pubmed(query: str, limit: int) -> list[LiteratureRecord]:
    payload = _fetch_json(f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term={quote(query)}&retmode=json&retmax={limit}")
    ids = payload.get("esearchresult", {}).get("idlist", [])
    return [LiteratureRecord(title=f"PubMed record {identifier}", identifier=str(identifier), identifier_kind="pmid", url=f"https://pubmed.ncbi.nlm.nih.gov/{identifier}/", source="PubMed") for identifier in ids]


def _arxiv(query: str, limit: int) -> list[LiteratureRecord]:
    request = Request(f"https://export.arxiv.org/api/query?search_query=all:{quote(query)}&max_results={limit}", headers={"Accept": "application/atom+xml", "User-Agent": "pi-science/0.1"}, method="GET")
    with urlopen(request, timeout=15) as response:
        root = ElementTree.fromstring(response.read(5 * 1024 * 1024))
    ns = "{http://www.w3.org/2005/Atom}"
    result = []
    for entry in root.findall(f"{ns}entry"):
        identifier = (entry.findtext(f"{ns}id") or "").rsplit("/", 1)[-1]
        result.append(LiteratureRecord(title=(entry.findtext(f"{ns}title") or "").strip().replace("\n", " "), authors=[(author.findtext(f"{ns}name") or "").strip() for author in entry.findall(f"{ns}author")], identifier=identifier, identifier_kind="arxiv", url=entry.findtext(f"{ns}id"), source="arXiv"))
    return result


_PROVIDERS = {"crossref": _crossref, "openalex": _openalex, "pubmed": _pubmed, "arxiv": _arxiv}


async def search(query: str, providers: list[str], limit: int) -> dict:
    async def run(provider: str):
        func = _PROVIDERS.get(provider)
        if func is None:
            return provider, [], f"unknown provider: {provider}"
        try:
            return provider, await asyncio.to_thread(func, query, limit), None
        except Exception as exc:
            return provider, [], str(exc)[:300]

    rows = await asyncio.gather(*(run(provider) for provider in providers))
    records: list[LiteratureRecord] = []
    errors: dict[str, str] = {}
    seen: set[tuple[str | None, str]] = set()
    for provider, values, error in rows:
        if error:
            errors[provider] = error
        for record in values:
            key = (record.identifier, record.title.lower())
            if key in seen:
                continue
            seen.add(key)
            records.append(record)
    return {"query": query, "records": [item.model_dump() for item in records[:limit * max(1, len(providers))]], "errors": errors}
