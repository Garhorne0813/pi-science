---
name: literature-review
description: Find, verify, and synthesize scientific literature with traceable citations. Works with zero configuration by querying the public Crossref, arXiv, and PubMed APIs directly via curl, prefers the pi-science control-plane literature gateway (/api/literature/search, which adds caching, rate limiting, egress audit and a sensitive-term gate over PubMed, GenBank, arXiv, PubChem and UniProt), and prefers configured literature MCP connectors when they are available. Use for literature searches, evidence tables, paper comparisons, and review-ready summaries.
version: 0.2.1
license: Apache-2.0
category: research
requirements:
  - name: network
    kind: service
    description: Outbound HTTPS access to public literature APIs (api.crossref.org, export.arxiv.org, eutils.ncbi.nlm.nih.gov, rest.uniprot.org, pubchem.ncbi.nlm.nih.gov), or a configured literature MCP connector that performs retrieval.
  - name: curl
    kind: command
    optional: true
    description: Used for the zero-configuration direct API path. Not needed when a literature MCP connector handles retrieval.
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
  - kind: service
    name: UniProtKB REST API
    provider: UniProt Consortium
    license: provider-terms
    info_url: https://www.uniprot.org/help/api
  - kind: service
    name: PubChem REST API
    provider: NCBI / U.S. National Library of Medicine
    license: provider-terms
    info_url: https://pubchem.ncbi.nlm.nih.gov/docs/rest
---

# Literature review

Ground every claim in retrieval results from a live provider. Never answer from memory, and never invent a DOI, PMID, arXiv id, accession, author-year citation, or search result that was not returned by a provider in this session.

## Retrieval strategy

1. Preferred path: if literature MCP tools are configured in this session (for example `literature.search` / `literature.fetch`, or another literature connector), use them first.
2. Local gateway: otherwise, prefer the pi-science control-plane gateway (`POST /api/literature/search` on the control plane, port 8787 by default). It queries the same public APIs (NCBI E-utilities incl. GenBank, arXiv, PubChem, UniProt) through one audited, cached, rate-limited path, and it hard-blocks sensitive queries before anything leaves the machine.
3. Zero-configuration fallback: if neither MCP tools nor the gateway are reachable, query the public HTTP APIs below directly with `curl` from the shell. No credentials or setup are required.
4. Failure handling: if a provider fails (non-2xx status, timeout, malformed payload), report that provider's failure explicitly and continue with the remaining providers. Never silently substitute memory for a failed or missing provider; if all providers fail, say so and stop.

## Local literature gateway (pi-science control plane)

    curl -s -X POST http://127.0.0.1:8787/api/literature/search \
      -H 'Content-Type: application/json' \
      -d '{"query": "<terms>", "providers": ["pubmed", "genbank", "arxiv", "pubchem", "uniprot"]}'

The response is JSON. `"blocked": false` means results came back:

    {"blocked": false, "results": [{"provider": "pubmed", "query": "<terms>", "hitCount": 10, "records": [{"id": "...", "title": "...", "url": "..."}], "retrievedAt": "...", "responseHash": "...", "cached": false}], "failures": []}

Sensitive queries are blocked by default — the gateway answers
`{"blocked": true, "categories": [...], "terms": [...]}` and **no request leaves the machine**. Categories include DNA/protein sequences, compound identifiers and clinical identifiers. To proceed deliberately, first call the approval endpoint for the exact query and its matched categories, then re-run the search with the returned token:

    curl -s -X POST http://127.0.0.1:8787/api/literature/approve \
      -H 'Content-Type: application/json' \
      -d '{"query": "<terms>", "categories": ["<matched-category>"]}'

    → {"approvedToken": "...", "expiresAt": "..."}

The token is single-use (consumed by the first search that uses it) and expires after 5 minutes; it only covers that exact query and those categories. Every outbound request is recorded in the egress audit regardless. When the gateway is unreachable (different port, standalone agent session), fall back to the direct API cheatsheet below.

The gateway port follows `PI_SCIENCE_PORT` (default 8787). The gateway covers PubMed, GenBank, arXiv, PubChem, and UniProt — the same public APIs as the direct paths below (plus GenBank, PubChem and UniProt), except Crossref, which remains direct-curl-only. Results from the two paths are interchangeable for the providers they share.

## Direct API cheatsheet (curl)

URL-encode query terms (spaces as `+` or `%20`). Replace `<terms>` with the encoded query.

Crossref (DOI-registered articles, books, preprints; JSON, records under `message.items`):

    curl -s "https://api.crossref.org/works?query=<terms>&rows=10&select=DOI,title,author,issued,container-title,is-referenced-by-count"

Append `&mailto=<contact-email>` to join Crossref's polite pool (the conventional way to get more reliable service), e.g. `&mailto=you@example.org`.

arXiv (preprints; response is Atom XML — parse `<entry>` elements for `id`, `title`, `author`, `published`):

    curl -s "https://export.arxiv.org/api/query?search_query=all:<terms>&max_results=10"

Use `https://` (or add `-L`): plain `http://export.arxiv.org` answers with an empty 301 redirect body. Sorting: `&sortBy=relevance` (default) or `&sortBy=submittedDate&sortOrder=descending` for the newest work. Field prefixes narrow the search: `ti:`, `au:`, `abs:`, `cat:` (e.g. `search_query=ti:<terms>+AND+cat:cs.LG`).

PubMed E-utilities (biomedical literature; two-step — search for ids, then fetch metadata):

    curl -s "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=<terms>&retmode=json&retmax=10"

then, with the returned `idlist`:

    curl -s "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=<id1>,<id2>&retmode=json"
    curl -s "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=<id1>&rettype=abstract&retmode=text"

Rate limit: without an API key NCBI allows about 3 requests/second — space out calls; with `&api_key=...` the limit rises to 10/second.

## Result handling

- Normalize identifiers before comparing: lowercase DOIs and strip any `https://doi.org/` or `doi:` prefix; reduce arXiv ids to the canonical `NNNN.NNNNN` form (strip the `arXiv:` prefix, the `http://arxiv.org/abs/` prefix, and any `vN` version suffix, e.g. `http://arxiv.org/abs/2301.01234v2` becomes `2301.01234`).
- Deduplicate across providers: match by normalized DOI first, then by normalized title plus year.
- For every kept record, preserve: identifier(s), title, authors, year, venue, provider name, and retrieval timestamp (ISO 8601 UTC).

## Output format (mandatory)

The frontend auto-detects DOI strings in assistant messages and renders citations from this exact convention. Every response produced with this skill must follow it:

1. Inline citations: immediately after each claim, cite the bare identifier — `doi:10.xxxx/yyyy` for DOI-registered works, `arXiv:NNNN.NNNNN` for arXiv-only works. Keep sentence punctuation off the identifier: wrap the citation in parentheses, e.g. "... first demonstrated in dye-sensitized cells (doi:10.1021/ja809598r).", or leave a space before the punctuation.
2. References section: end the response with a `## References` heading followed by one numbered entry per cited source: authors (year), title, venue, a resolvable link (`https://doi.org/<doi>` or `https://arxiv.org/abs/<id>`), the provider the record came from, and the retrieval date. Example:

       ## References
       1. Kojima et al. (2009). Organometal halide perovskites as visible-light sensitizers for photovoltaic cells. Journal of the American Chemical Society. https://doi.org/10.1021/ja809598r — Crossref, retrieved 2026-07-26.

3. Unsourced claims: any claim without a retrieved source must be explicitly labeled as synthesis, e.g. "(synthesis, unverified)". Never attach an invented identifier to make a claim look sourced.

## Review artifacts

For each review also produce (condensed is fine): a search record (provider, exact query, date, hit count per search), an evidence table linking claims to identifiers and evidence strength, explicit inclusion/exclusion criteria, and a limitations section (coverage gaps, provider failures, screening depth). Distinguish retrieved facts from synthesis and unresolved questions.
