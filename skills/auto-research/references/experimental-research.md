# Experiments and evaluation

Freeze protocol and resource limits → validate the independent evaluator and comparable baseline when available → select a bounded hypothesis → implement/debug a Candidate → formally evaluate → review validity → Parent decides. Retrieve methods/benchmarks through authorized Researcher tools when needed.

## Evaluation protocol

Write evaluation.yaml with version, objective/deliverable, research type, observable success criteria, validity constraints, evidence checks, budget (research_id, max_seconds, max_execution_calls, max_experiments) and stopping conditions. Values are task-specific, not universal thresholds. Literature/exploration uses coverage, independent evidence, citation support and gaps. Quantitative work adds metric formula/unit/direction/target, data versions/digests and splits, validated evaluator revision/digest, baseline and uncertainty/robustness checks. Validate known answers and edge cases. Compare with identical data, splits, metric, evaluator and seed policy. Preserve reviewed revisions and explain changes; do not adjust thresholds to rescue failures. Final-test tuning is a blocking validity failure.

Required-mode Parent Bash/Notebook cannot access research/ or frozen evaluator inputs. This version has no production server-controlled evaluator API. Report trusted evaluator unavailable before spending Candidate execution budget on workflows requiring independent scoring unless an operator supplies independently executed evaluation evidence. Never switch to trusted-host or move held-out data into ordinary access as a workaround. Candidate self-reported metrics are local checks; Reviewer PASS does not replace formal evaluation or override objective failure. No universal evaluator ships with this Skill.

## Candidate execution

The Parent prepares research/<research-id>/candidates/<candidate-id>/input and work, binds execution_budget.research_id and explicitly sets candidate_id on each subagent task. Give the Experimenter its hypothesis, protocol revision, approved input descriptions, expected outputs and local budget. Use separate Candidate directories. Task prose does not grant authorization. The default Experimenter tools are read, bash, notebook_read and notebook_run, intersected with the Parent's active capabilities.

| Need | Entry |
| --- | --- |
| One CLI command or Python script, including repair | bash |
| Stateful Python analysis with shared cell variables | notebook_read / notebook_run |
| Existing historical sandbox_run invocation/workflow | Compatibility only, via an explicitly preserved legacy role/tool declaration |

Bash starts in Candidate work; approved inputs are in ../input. Create/edit scripts and top-level work notebooks through Bash. Notebook reads top-level regular input/work notebooks and executes only work notebooks. Neither grants access to protected evaluator data or another Candidate. If isolation/tools/dependencies are unavailable, return proposed code without claiming execution; never try another tool to escape the failed isolation boundary. Exact safety and recovery rules are in experiment-safety.md.

## Formal Experiment results

Use a new experiment_id for each controlled hypothesis test, distinct from candidate_id. Link actual debug/repair Execution IDs in manifest.json; a successful process does not complete an Experiment. Save hypothesis, frozen protocol/evaluator/data/code/input/environment digests, parameters, seeds, raw outputs, uncertainty, local checks, failures/resource observations and actual artifact references in experiments/<experiment-id>/result.json. Formal metrics require independent evaluation evidence and matching frozen versions. Only the manifest stores completion state and relationships. Report results awaiting evaluation as awaiting_evaluation or blocked, never completed. The Parent reviews/retains/rolls back; children return evidence rather than maintaining global research state.
