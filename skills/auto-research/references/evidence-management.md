# Evidence and traceability

Assign stable source and claim IDs. Retain identifiers/URLs, provider, authors/date, retrieval timestamp, excerpt or source artifact path, data version/digest and run references. For each claim list supporting and contradicting source_refs, confidence with justification, whether observed or inferred, and unresolved gaps. Preserve negative results and failed experiments.

Deduplicate by canonical identifier and content; two providers serving the same paper are not independent evidence. Check that the cited source actually supports the claim. Use the literature-review citation convention for retrieved publications. Retrieval uses authorized scientific/Web Access MCP. Researcher can retrieve with exact delegated tools; the parent handles one-off ask approvals or supplies evidence. Never use retired Literature HTTP APIs. Persist URLs, excerpts, timestamps and content hashes; responseId is only a temporary worker-local pagination handle.

Use the existing session tool history, execution runs, artifact manifests and provenance references as authority. Evidence.md and state.json supplement those records rather than duplicating their event system. Protocol revisions and experiment results must refer back to the relevant input, evaluator version, run and artifact paths.
