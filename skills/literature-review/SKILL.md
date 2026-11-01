---
name: literature-review
description: Find, verify, and synthesize scientific literature with traceable citations. Use configured MCP tools for literature and scientific data retrieval, including Crossref, PubMed, arXiv, GenBank, PubChem, and UniProt. Use for literature searches, evidence tables, paper comparisons, and review-ready summaries.
version: 0.5.0
license: Apache-2.0
category: research
requirements:
  - name: literature-mcp
    kind: service
    description: An enabled MCP connector providing the requested literature or scientific data tools. The built-in Paper Search connector is enabled by default; specialized scientific data connectors must be enabled as needed.
  - name: network
    kind: service
    description: Outbound HTTPS access from the MCP service to the selected public provider API.
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
    name: bioRxiv / medRxiv API
    provider: Cold Spring Harbor Laboratory
    license: provider-terms
    info_url: https://api.biorxiv.org/
  - kind: service
    name: Europe PMC API
    provider: Europe PMC
    license: provider-terms
    info_url: https://europepmc.org/RestfulWebService
  - kind: service
    name: ENA Browser API
    provider: EMBL-EBI
    license: provider-terms
    info_url: https://www.ebi.ac.uk/ena/browser/api/
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

1. Use MCP tools available in this session for all retrieval. The built-in Paper Search connector is enabled by default and covers Crossref, PubMed, arXiv, bioRxiv/medRxiv, and Europe PMC open-access text. Other configured MCP connectors can provide equivalent capabilities. Follow the connector's tool permissions and data-egress settings.
2. Choose the provider and tool for the requested task. Scientific data connectors are disabled by default; enable the relevant connector in Pi-Science MCP settings when needed, then make its tools available to the session.
3. If a required tool is unavailable or its connector is disabled, report the missing capability and identify the connector to enable. Do not silently substitute another provider, use a shell command or direct HTTP request as a fallback, or invent results. If no suitable retrieval tool is available, stop and explain what must be configured.
4. If a provider fails (non-2xx status, timeout, malformed payload), report that provider's failure explicitly and continue with other suitable available MCP tools. Never silently substitute memory for a failed or missing provider; if all suitable providers fail, say so and stop.

## MCP tools and provider coverage

Use the actual tool names exposed by the session; the runtime may add a connector prefix. The built-in connectors provide:

| Connector | Tools | Coverage |
| --- | --- | --- |
| Paper Search | `search_crossref`, `search_pubmed`, `search_arxiv` | Crossref DOI and publication metadata, PubMed articles, arXiv preprints |
| Paper Search | `search_biorxiv_preprints`, `get_europe_pmc_full_text` | bioRxiv/medRxiv preprints and bounded Europe PMC open-access full text |
| Protein Records | `search_uniprot_proteins`, `get_uniprot_entry`, `get_uniprot_sequence` | UniProtKB protein records and sequences |
| Nucleotide Archives | `search_genbank_sequences`, `get_genbank_sequence`, `get_ena_sequence` | GenBank nucleotide records and GenBank/ENA sequences |
| Chemistry | `search_pubchem_compounds`, `get_pubchem_compound` | PubChem compound properties and synonyms |

Crossref retrieval uses `search_crossref`, including DOI-oriented searches. For an exact UniProt accession, prefer `get_uniprot_entry`; use `search_uniprot_proteins` when an accession is unknown. Request sequence output only when needed. Keep pagination and output bounds appropriate to the task, and retain provider identifiers and retrieval metadata from the MCP response.

## Result handling

- Normalize identifiers before comparing: lowercase DOIs and strip any `https://doi.org/` or `doi:` prefix; reduce arXiv ids to the canonical `NNNN.NNNNN` form (strip the `arXiv:` prefix, the `http://arxiv.org/abs/` prefix, and any `vN` version suffix, e.g. `http://arxiv.org/abs/2301.01234v2` becomes `2301.01234`).
- Deduplicate across providers: match by normalized DOI first, then by normalized title plus year.
- For every kept record, preserve: identifier(s), title, authors, year, venue, provider name, and retrieval timestamp (ISO 8601 UTC).

## Citing from source text

Two tools in this session read a cited source's open full text and record what you used.

- `read_source_evidence` returns one source as numbered passages, with a `snapshot_id` for the read and a `passage_id` for each paragraph, plus its section and, when the PDF states one, its file page. Page a long paper with `skip`. A state other than `available` says why there is no text: no open full text, access refused, download failed, unreadable body, a PDF with no text layer, or only another version.
- `cite_evidence` records which passages of which snapshot you used for one sentence.

Rules:

1. Read before you cite. Quote only a paragraph `read_source_evidence` returned, and only from the snapshot it named.
2. After you put a citation into your answer, call `cite_evidence` with the source, the sentence exactly as you wrote it, the `snapshot_id` and the passage ids you used. A reader then opens the paragraph you chose, not one a search guessed afterwards.
3. A rejected selection is not recorded. Read the source again and select a passage that was returned, or state only what the metadata supports.
4. If you never read the source, do not call `cite_evidence`. The source then shows that no generation-time text was recorded, which is accurate.
5. A recorded passage is text from the paper. It is not a finding that the paper supports the sentence, and saying it does is your reading, not the record's.

## Output format (mandatory)

The frontend lifts the bare DOI and arXiv identifiers out of your prose and turns them into source links, and it numbers them per answer version. Write the identifiers; do not write numbers into a chat reply, because the numbering belongs to the rendered version and a hand-written number would survive a regenerated answer with the wrong source behind it.

A report file you write to the workspace is different: nothing rewrites it after you write it, so the file has to carry both halves of the citation convention itself. See the report rule below.

1. Inline citations: immediately after each claim, cite the bare identifier — `doi:10.xxxx/yyyy` for DOI-registered works, `arXiv:NNNN.NNNNN` for arXiv-only works. Keep sentence punctuation off the identifier: wrap the citation in parentheses, e.g. "... first demonstrated in dye-sensitized cells (doi:10.1021/ja809598r).", or leave a space before the punctuation.
2. References section: end the response with a `## References` heading followed by one numbered entry per cited source: authors (year), title, venue, a resolvable link (`https://doi.org/<doi>` or `https://arxiv.org/abs/<id>`), the provider the record came from, and the retrieval date. Example:

       ## References
       [1] Kojima et al. (2009). Organometal halide perovskites as visible-light sensitizers for photovoltaic cells. Journal of the American Chemical Society. https://doi.org/10.1021/ja809598r — Crossref, retrieved 2026-07-26.

3. Report files: a report written to the workspace must be read correctly on its own, without the app in front of it. So it carries the numbering in the document, not only on screen:
   - Number in the body, paper style, at the claim: "该研究报告了这一结果 [1]". `doi:10.xxxx/yyyy` and `arXiv:NNNN.NNNNN` stay written wherever the text is about the identifier itself or where the link text carries meaning. Never replace a meaningful identifier with a bare number.
   - Number in first-citation order. A source cited a second time reuses its number: `[1]`, `[1]`, `[2]`.
   - End the file with a `## References` list that uses the same numbers as the body, one entry per source, carrying the title, authors, year, venue, and the DOI, arXiv id or link. A reader must be able to trace any `[n]` in the body to its entry without opening the app.
   - Two versions of one arXiv paper are two entries, because a newer version is not evidence for what an older one said. Never merge two sources because their titles look alike.
4. Unsourced claims: any claim without a retrieved source must be explicitly labeled as synthesis, e.g. "(synthesis, unverified)". Never attach an invented identifier to make a claim look sourced.

## Review artifacts

For each review also produce (condensed is fine): a search record (provider, exact query, date, hit count per search), an evidence table linking claims to identifiers and evidence strength, explicit inclusion/exclusion criteria, and a limitations section (coverage gaps, provider failures, screening depth). Distinguish retrieved facts from synthesis and unresolved questions.
