---
name: literature-review
description: Find, verify, and synthesize scientific literature with traceable citations using the configured paper-search MCP. Use for literature searches, evidence tables, paper comparisons, and review-ready summaries.
version: 0.3.0
license: Apache-2.0
category: research
required_mcp_tools:
  - paper_search_search_pubmed
  - paper_search_search_arxiv
  - paper_search_search_crossref
risk: low
third_party:
  - kind: service
    name: Crossref REST API
    provider: Crossref
    license: provider-terms
    info_url: https://www.crossref.org/documentation/retrieve-metadata/rest-api/
    privacy_url: https://www.crossref.org/operations-and-sustainability/privacy/
  - kind: service
    name: arXiv API
    provider: arXiv (Cornell University)
    license: provider-terms
    info_url: https://info.arxiv.org/help/api/index.html
    terms_url: https://info.arxiv.org/help/api/tou.html
  - kind: service
    name: PubMed E-utilities
    provider: NCBI / U.S. National Library of Medicine
    license: provider-terms
    info_url: https://www.ncbi.nlm.nih.gov/books/NBK25501/
    privacy_url: https://www.nlm.nih.gov/web_policies.html
---

# Literature review

Ground every claim in retrieval results from a live provider. Never answer from memory, and never invent a DOI, PMID, arXiv id, accession, author-year citation, or search result that was not returned by a provider in this session.

## Retrieval strategy

1. Use the configured `paper-search` MCP only. Discover its available tools when necessary; do not call a Pi-Science literature HTTP gateway or maintain provider-specific `curl` fallbacks.
2. Search more than one relevant source when the topic permits. Use `paper_search_search_pubmed` for biomedical literature, `paper_search_search_arxiv` for preprints, and `paper_search_search_crossref` for DOI metadata and identifier verification.
3. Use several focused query variants for broad reviews. Record the exact query, MCP tool, retrieval date, hit count, and any provider error.
4. Treat titles and snippets as discovery evidence, not full support for detailed methodological claims. Use paper-search fetch or download tools when available to inspect abstracts or full text; otherwise label the screening depth explicitly.
5. If one paper-search provider fails, report the failure and continue with the others. Never silently substitute memory. If the required MCP is unavailable or all searches fail, say that the literature review could not be completed and stop.

## Result handling

- Normalize identifiers before comparing: lowercase DOIs and strip any `https://doi.org/` or `doi:` prefix; reduce arXiv ids to the canonical `NNNN.NNNNN` form (strip the `arXiv:` prefix, the `http://arxiv.org/abs/` prefix, and any `vN` version suffix, e.g. `http://arxiv.org/abs/2301.01234v2` becomes `2301.01234`).
- Deduplicate across providers: match by normalized DOI first, then by normalized title plus year.
- For every kept record, preserve: identifier(s), title, authors, year, venue, paper-search source, and retrieval timestamp (ISO 8601 UTC).

## Output format (mandatory)

The frontend auto-detects DOI strings in assistant messages and renders citations from this exact convention. Every response produced with this skill must follow it:

1. Inline citations: immediately after each claim, cite the bare identifier — `doi:10.xxxx/yyyy` for DOI-registered works, `arXiv:NNNN.NNNNN` for arXiv-only works. Keep sentence punctuation off the identifier: wrap the citation in parentheses, e.g. "... first demonstrated in dye-sensitized cells (doi:10.1021/ja809598r).", or leave a space before the punctuation.
2. References section: end the response with a `## References` heading followed by one numbered entry per cited source: authors (year), title, venue, a resolvable link (`https://doi.org/<doi>` or `https://arxiv.org/abs/<id>`), the provider the record came from, and the retrieval date. Example:

       ## References
       1. Kojima et al. (2009). Organometal halide perovskites as visible-light sensitizers for photovoltaic cells. Journal of the American Chemical Society. https://doi.org/10.1021/ja809598r — Crossref, retrieved 2026-07-26.

3. Unsourced claims: any claim without a retrieved source must be explicitly labeled as synthesis, e.g. "(synthesis, unverified)". Never attach an invented identifier to make a claim look sourced.

## Review artifacts

For each review also produce (condensed is fine): a search record (paper-search tool/source, exact query, date, hit count per search), an evidence table linking claims to identifiers and evidence strength, explicit inclusion/exclusion criteria, and a limitations section (coverage gaps, provider failures, abstract/full-text screening depth). Distinguish retrieved facts from synthesis and unresolved questions.
