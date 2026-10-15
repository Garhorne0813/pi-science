# Task-specific Evaluation Protocol

All tasks need a protocol; only appropriate tasks need a numerical benchmark. Write `evaluation.yaml` before iterative execution. Example fields (values must be agreed for this task):

```yaml
version: 1
objective: <research question and deliverable>
type: literature # optimization, simulation, statistics, exploratory, theory
success: [<observable success criteria>]
evidence_checks: [coverage, source_independence, citation_integrity]
constraints: [reproducibility, no_data_leakage]
budget:
  research_id: <research-id> # bind execution_budget before the first costly call
  max_seconds: 600
  max_execution_calls: 20
  max_experiments: 5
stop: [goal_with_no_blockers, convergence, budget_exhausted, dependency_missing]
```

For quantitative tasks add metric name, formula, unit, direction, target, benchmark, baseline, dataset version/digest, training/validation/final-test split and evaluator path/version/digest. Include assumptions, effect sizes/uncertainty and robustness checks as appropriate. The example budget is not a universal default or success threshold.

Create the evaluator in `research/<id>/`, never as a skill-wide evaluate.py. Validate a known-answer reference and boundary inputs before establishing baseline. Use identical data splits and metric definitions for baseline and candidates. Use validation for iteration; reserve final-test data for the final assessment. Do not adjust the metric, split or thresholds to rescue a failed candidate. Freeze reviewed core measures; preserve old protocol/evaluator versions, explain revisions and reevaluate affected results. Reviewer flags methodological failure independently of computed metrics.

For literature, define search/screening scope, independent sources, claim coverage, accurate citations, counterevidence and gap handling. For exploratory/theoretical work, define testable hypotheses, consistent premises, counterexamples and formal checks where applicable. Do not generate numeric evidence_quality or objective_progress scores without a defensible task-specific definition.
