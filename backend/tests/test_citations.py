"""Citation identity and verification tests."""

import pytest

from models.citation import Citation
from services import citation_service
from services.citation_service import deduplicate, normalize_identifier, verify


def test_normalize_supported_identifier_forms():
    doi = normalize_identifier("https://doi.org/10.1000/ABC.1")
    pmid = normalize_identifier("https://pubmed.ncbi.nlm.nih.gov/12345/")
    arxiv = normalize_identifier("https://arxiv.org/abs/2401.01234v2")
    url = normalize_identifier("https://example.org/paper")
    assert (doi.kind, doi.identifier) == ("doi", "10.1000/abc.1")
    assert pmid.identifier == "12345"
    assert arxiv.identifier == "2401.01234"
    assert url.kind == "url"


def test_deduplicate_preserves_richer_metadata():
    base = normalize_identifier("10.1000/test")
    rich = base.model_copy(update={"title": "A title", "year": 2024})
    result = deduplicate([base, rich])
    assert len(result) == 1
    assert result[0].title == "A title"
    assert result[0].year == 2024


def test_invalid_identifier_is_rejected():
    with pytest.raises(ValueError):
        normalize_identifier("not-a-doi")


@pytest.mark.anyio
async def test_verify_doi_uses_provider_metadata(monkeypatch):
    def fake_fetch(url: str, **_kwargs):
        assert "api.crossref.org/works/10.1000/test" in url
        return 200, "application/json", '{"message":{"title":["Example"],"author":[{"given":"A","family":"Researcher"}],"published":{"date-parts":[[2024]]}}}'

    monkeypatch.setattr(citation_service, "_fetch", fake_fetch)
    result = await verify(normalize_identifier("10.1000/test"))
    assert result.verification == "verified"
    assert result.title == "Example"
    assert result.year == 2024
    assert result.source == "Crossref"


@pytest.mark.anyio
async def test_citation_api_reports_normalization_errors(client):
    response = await client.post(
        "/api/citations/normalize",
        json={"identifiers": ["10.1000/Test", "not-valid"]},
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data["citations"]) == 1
    assert len(data["errors"]) == 1

