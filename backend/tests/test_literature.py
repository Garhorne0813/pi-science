"""Normalized literature provider tests."""

import pytest

from services import literature_service


@pytest.mark.anyio
async def test_literature_search_normalizes_and_reports_provider_errors(client, monkeypatch):
    def fake_json(url: str):
        if "crossref" in url:
            return {"message": {"items": [{"title": ["A paper"], "DOI": "10.1000/example", "published": {"date-parts": [[2024]]}}]}}
        if "openalex" in url:
            raise RuntimeError("provider unavailable")
        return {"esearchresult": {"idlist": ["12345"]}}

    monkeypatch.setattr(literature_service, "_fetch_json", fake_json)
    monkeypatch.setattr(literature_service, "_arxiv", lambda _query, _limit: [])
    response = await client.post("/api/literature/search", json={"query": "kinase", "providers": ["crossref", "openalex", "pubmed", "arxiv"], "limit": 5})
    assert response.status_code == 200
    data = response.json()
    assert any(item["identifier"] == "10.1000/example" for item in data["records"])
    assert any(item["identifier"] == "12345" for item in data["records"])
    assert "openalex" in data["errors"]

