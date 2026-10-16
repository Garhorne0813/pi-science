# Experiments and evaluation

## Task-specific protocol

Before substantial computation, write a versioned evaluation.yaml describing the objective, deliverable, metric/formula/unit/direction and target (when quantitative), data sources and splits, baseline, constraints, parameters/seeds, environment, budget and stopping rules. Literature, exploratory and theoretical tasks use evidence criteria instead of a mandatory numerical evaluator.

The Parent creates or selects a task-specific evaluator under research/<research-id>/evaluator/ using ordinary file tools. Use Bash for scripts and Notebook for stateful Python, subject to actual runtime availability. Check known answers, boundary conditions and invalid inputs before accepting the baseline. Save evaluator/data/code digests, parameters, environment and actual baseline Execution/Artifact references. No universal evaluator ships with this Skill; no operator registry or dedicated scoring tool is required.

Once candidate comparison begins, keep the evaluation version fixed. A changed evaluator, data split, metric or environment requires a new protocol version and reevaluation or an explicit incomparable result. Preserve the old evidence. Parent evaluation is independent of Candidate self-reported scores; it cannot hide data from a malicious Parent or guarantee tamper-proof official scoring.

## Candidate and evaluation loop

Bind execution_budget to research_id, then prepare candidates/<candidate-id>/input and work. Delegate bounded implementation/repair tasks to Experimenter when useful, assigning candidate_id through subagent. Its Bash/Notebook access is limited to that Candidate; approved inputs are in ../input and work is writable. It cannot read the Parent evaluator or sibling Candidates. If required isolation or dependencies are unavailable, report the dependency or return proposed code, never claim execution or select host fallback.

Run the validated evaluator as Parent through ordinary sandboxed Bash/Notebook against the actual candidate output or a verified Artifact snapshot. Use the same evaluator, data, parameters and environment as the baseline. Write the measurement and validity checks to a result file so the tool publishes an immutable Artifact. Use returned Execution/Artifact references; never invent IDs or digests. Inspect failures and validity separately: exit code zero, Candidate stdout and Reviewer PASS alone do not establish scientific success.

Compare valid, compatible measurements and decide keep/discard/repair/stop. A failed run can be repaired under the same Candidate with a new Execution; a controlled hypothesis test gets its own experiment_id. Optional Reviewer checks methodology and interpretation, without overriding objective failure. Stop when the target and validity criteria are met, progress stalls, the budget expires or dependencies are missing.

## Evidence and completion

Store hypothesis, protocol/evaluator/data/code/input/environment versions, parameters, seeds, uncertainty, raw output references, validity and decision rationale in experiments/<experiment-id>/result.json. Link debug, repair and Parent evaluation executions in manifest.json. Mark completed only after checking the actual successful evaluation Execution, its result Artifact and passed task-specific validity checks; completion does not imply improvement. Use evaluation.source=parent_tool for ordinary Parent evaluation, or external_operator for clearly attributed manual evidence. Results awaiting independent evaluation stay awaiting_evaluation or blocked.

Only the Parent updates the manifest and checkpoint. On continuation, reuse matching completed evidence; inspect uncertain, failed or cancelled executions before choosing a fresh invocation. Never silently rerun an uncertain experiment or change a metric to make a candidate pass.
