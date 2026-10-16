---
name: auto-research
description: Optimize scientific experiments or investigate evidence in the current conversation using task-specific evaluation, bounded execution and reproducible checkpoints.
version: 1.4.0
license: Apache-2.0
category: research
risk: low
required_tools: [read, write, execution_budget]
---

# Auto Research

The current conversation Agent owns understanding, planning, optional delegation, iteration and stopping. Use existing tools and session history; never start a Research API or separate coordinator.

1. Read [research protocol](references/research-protocol.md) for scope, evidence, budgets, the single manifest, reporting and continuation. Confirm material missing assumptions through the existing conversation questionnaire/reply path.
2. Read [experiments and evaluation](references/experimental-research.md) for quantitative or mixed work. Confirm a task-specific evaluation protocol and available sandboxed Bash/Notebook tools before spending Candidate execution budget. Literature-only work uses evidence criteria and needs no Experimenter or numerical benchmark.
3. Read [safety and recovery](references/experiment-safety.md) before execution, delegation or recovery. Use Bash for CLI/Python scripts and Notebook for stateful Python analysis. Historical sandbox_run remains compatibility-only.

For delegation use exact Skill-local names `auto-research/researcher`, `auto-research/experimenter` and `auto-research/reviewer`; use only roles needed for this task.

Write a versioned evaluation.yaml before substantial research. Before the first Bash/Notebook/subagent call, bind execution_budget with research_id, max_seconds and max_executions; reuse that research_id across continuation. A budget already used without research_id cannot be rebound; report that blocker and stop instead of retrying or probing private state. Create research/<research-id>/manifest.json from templates/research-manifest.json when an actual Candidate/Experiment exists or resumable multi-step work needs that index. It is the sole experiment completion ledger when present. Simple source-only work uses an evidence/report checkpoint without empty Candidate/Execution/Experiment indexes. Existing Session/Execution/Artifact/Provenance records remain authoritative execution evidence. Do not invent a universal quality score, fabricate references or treat process success or Reviewer PASS as scientific success.
