---
name: auto-research
description: Investigate scientific evidence with a lightweight literature workflow, or run bounded experiments with task-specific evaluation and reproducible checkpoints.
version: 1.6.0
license: Apache-2.0
category: research
risk: medium
required_tools: [read, write]
---

# Auto Research

The current conversation Agent owns the question, evidence, optional delegation and stopping. Use existing tools and history; never start a separate coordinator. Choose the smallest workflow that answers the question.

- **Literature / Research Lite**: search, read, verify sources and synthesize a report. Read only [literature research](references/literature-research.md). No Candidate, evaluator, manifest or separate state file is required. Use supplied evidence when retrieval tools are unavailable. Stay in this mode unless computation or experimental comparison is actually needed.
- **Experimental Research**: before computation or Candidate implementation, read [research protocol](references/research-protocol.md), [experiments and evaluation](references/experimental-research.md) and [safety and recovery](references/experiment-safety.md). Write a versioned evaluation.yaml. This mode requires authorized sandboxed Bash/Notebook. Execution limits and cancellation are managed by the host; no budget tool call or runtime research binding is required. Report missing capabilities without host fallback.

Delegation is optional. Built-in roles are auto-research/researcher, auto-research/experimenter and auto-research/reviewer; use only available authorized roles. Retrieval-only delegation uses ordinary runtime limits and does not require research_id. Confined execution is enforced by server-validated sandbox grants and the execution_scope: confined declaration, never by role names or Candidate IDs. Auto Research owns Candidate IDs/directories; candidate_id is optional correlation metadata on the grant path.

Use an append-only research-events.jsonl decision history only for multi-round experiments, cross-Candidate comparison or recovery. manifest.json is an optional, rebuildable projection. A single bounded analysis can retain its protocol, result and actual Execution/Artifact references in the report. Do not initialize empty indexes for literature work. Parent appends decisions with stable event IDs using the Skill journal helper; never edit the projection as a completion ledger. Existing studies require explicit legacy import before journal-based continuation; the strict v1 index validator remains compatible. Existing Session/Execution/Artifact/Provenance records remain authoritative. Never fabricate references, invent a universal quality score or equate process success or Reviewer PASS with scientific success.
