---
name: literature-review
description: Find, verify, and synthesize scientific literature with traceable citations. Use for literature searches, evidence tables, paper comparisons, and review-ready summaries.
version: 0.1.0
license: Apache-2.0
category: research
requirements:
  - name: network
    kind: service
    optional: true
    description: A configured literature connector such as Crossref, OpenAlex, PubMed, or arXiv.
required_mcp_tools:
  - literature.search
  - literature.fetch
risk: low
third_party:
  - kind: service
    name: Literature metadata provider
    license: provider-terms
    info_url: https://www.crossref.org/documentation/retrieve-metadata/
    privacy_url: https://www.crossref.org/operations-and-sustainability/privacy/
---

# Literature review

Use real retrieval results as the source of truth. Normalize identifiers, deduplicate records, preserve the provider and retrieval time, and label each claim with its evidence strength. Never invent a DOI, PMID, accession, author-year citation, or result that was not returned by a configured source.

For each review, produce a compact search record, an evidence table, explicit inclusion/exclusion criteria, and a limitations section. Distinguish retrieved facts from synthesis and unresolved questions. If a provider is unavailable, report the failure and do not silently replace it with memory.

