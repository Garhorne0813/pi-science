---
name: auto-research
description: Optimize scientific experiments or investigate evidence in the current conversation using task-specific evaluation, bounded execution and reproducible checkpoints.
version: 1.2.0
license: Apache-2.0
category: research
risk: low
required_tools: [read, write, execution_budget]
---

# Auto Research

The current conversation Agent owns understanding, planning, optional delegation, iteration and stopping. Use existing tools and session history; never start a Research API or separate coordinator.

1. Read [research protocol](references/research-protocol.md) for scope, evidence, budgets, the single manifest, reporting and continuation. Confirm material missing assumptions through the existing conversation questionnaire/reply path.
2. Read [experiments and evaluation](references/experimental-research.md) for quantitative or mixed work. Check independent evaluation availability before spending Candidate execution budget. Literature-only work uses evidence criteria and needs no Experimenter or numerical benchmark.
3. Read [safety and recovery](references/experiment-safety.md) before execution, delegation or recovery. Use Bash for CLI/Python scripts and Notebook for stateful Python analysis. Historical sandbox_run remains compatibility-only.

Write a versioned evaluation.yaml before substantial research and bind execution_budget to the same research_id across continuation. Initialize research/<research-id>/manifest.json from templates/research-manifest.json: it is the sole Candidate/Experiment/Execution relationship index and experiment completion ledger. Existing Session/Execution/Artifact/Provenance records remain authoritative execution evidence. Do not invent a universal quality score, fabricate references or treat process success or Reviewer PASS as scientific success.
