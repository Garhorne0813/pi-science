---
name: auto-research
description: Conduct autonomous scientific research, literature investigations, optimization, comparison, evaluation, or reproduction within the current conversation. Establish a task-specific evaluation protocol, delegate bounded subquestions and independent review when useful, execute scientific tools, and save reproducible evidence and checkpoints.
version: 1.0.0
license: Apache-2.0
category: research
risk: low
required_tools: [read, write, execution_budget]
---

# Auto Research

The current conversation Agent owns understanding, planning, delegation, iteration and stopping. Use existing tools and session history. Never call a Research API, start a supervisor/coordinator, or impose a fixed role pipeline.

1. Understand the objective, expected deliverable, available evidence/data, constraints, research type and budget. Ask via `ask_user_question` only for material missing assumptions or objective/protocol approval when needed; conversation replies are the continuation path.
2. Read [evaluation-design.md](references/evaluation-design.md). Before substantial research, save a versioned `evaluation.yaml` with success criteria, objective measures or nonnumeric review checks, data sources/splits, validity constraints, budget and stopping conditions. Do not invent a universal quality score. Configure the generic `execution_budget` tool before retrieval, delegation or computation with the agreed remaining time and execution-call allowance. A tool call is not the same as an experiment: record both budgets and use bounded one-experiment commands. Runtime limits cannot be expanded in the same operation.
3. For quantitative work, build a task-specific evaluator in the research workspace (Python, R, SQL, script or existing scientific tool). Validate against known answers and edge cases; establish comparable baseline results with the same metric, data version and evaluator. For literature/exploratory work, use coverage, independent evidence, verified citations and explicit gaps; an executable evaluator is optional.
4. When independent review adds value, call `subagent` with `agent: "auto-research/reviewer"` to review the protocol before execution, at consequential milestones and before delivery. Pass protocol, evidence and file paths; repair blocking issues before continuing. A Reviewer PASS never overrides a failed objective metric, and a passing metric never overrides critical validity failures. Simple work can use explicit self-checks; explain any omitted independent review.
5. Read [research-loop.md](references/research-loop.md) and [evidence-management.md](references/evidence-management.md). Dynamically select bounded subquestions. Call `auto-research/researcher` only when parallelism, context isolation or independent perspectives help. The existing `subagent` tool supports `{agent, task}`, `{tasks: [{agent, task}, ...]}` (up to four in parallel) and `{chain: [...]}`; no mandatory chain. Multiple tasks may use the same researcher role.
6. Retrieve with the parent's scientific MCP or literature-review skill, then pass actual source material to children. Children cannot use MCP, ask users, or expand the parent's tool allowance. Never assume a child can retrieve or run an experiment. Use the parent's Python/R/notebook/bash/file tools for experiments and objective evaluation. Observe kernel, job and tool timeouts; save parameters, seeds, environment, dataset/evaluator digests, results and execution/artifact/provenance references.
7. Integrate structured claims, conflicts and gaps; evaluate; review; decide continue, change strategy, ask for a dependency, or stop. Stop on goal achieved with no blockers, adequate coverage with no material progress, exhausted budget, missing dependencies, or material risk. Convergence and Reviewer PASS do not prove correctness. Report budget exhaustion as incomplete.
8. Read [reporting.md](references/reporting.md) and write the report with objective metrics, review findings and unresolved blockers separately. Link research outputs in the conversation using workspace-relative Markdown paths so the existing file inspector/artifact UI can open them.

## Workspace and continuation

Use `research/<research-id>/` with `plan.md`, `evaluation.yaml`, optional evaluator and `baseline.json`, `state.json`, `evidence.md`, `experiments/<id>/{params,result}.json`, protocol revision snapshots and `report.md`. These files hold semantic checkpoints; Session/Runs/Artifacts/Provenance remain authoritative execution records. Do not create a new event log or scheduling state machine.

After each consequential result and before stopping, atomically save a checkpoint containing protocol version, current phase, remaining budget, completed experiment IDs and input/evaluator digests, saved result paths, evidence gaps, blockers, next actions and session/run/artifact references. Preserve protocol/evaluator revisions and the reasons for changes. Checkpoint after a tool result rather than marking an unfinished experiment complete.

On "continue"/"resume", read the plan, protocol, state, evidence and existing results first. Reuse completed experiments whose inputs and evaluator versions match; inspect existing run results before repeating an interrupted operation. Reassess affected results after protocol changes. Configure a new operation budget with the remaining allowance, never silently replenish it. Do not promise browser-close/background autonomous recovery; the user can return to the conversation and continue using saved context.

Historical research archives in Knowledge are read-only source records. To continue one, inspect the linked archive and original artifacts, create a new skill workspace and protocol, carry over valid results with their original references, and explicitly state the old task is not being restarted by its former scheduler.
