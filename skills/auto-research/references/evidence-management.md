# Evidence and traceability

Assign stable source and claim IDs. Retain identifiers/URLs, provider, authors/date, retrieval timestamp, excerpt or source artifact path, data version/digest and run references. For each claim list supporting and contradicting source_refs, confidence with justification, whether observed or inferred, and unresolved gaps. Preserve negative results and failed experiments.

Deduplicate by canonical identifier and content; two providers serving the same paper are not independent evidence. Check that the cited source actually supports the claim. Use the literature-review citation convention for retrieved publications. Parent retrieval uses available scientific MCP or the literature gateway; children analyze provided evidence without extra permissions.

Use the existing session tool history, execution runs, artifact manifests and provenance references as authority. Evidence.md and state.json supplement those records rather than duplicating their event system. Protocol revisions and experiment results must refer back to the relevant input, evaluator version, run and artifact paths.
