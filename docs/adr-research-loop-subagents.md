# ADR: Durable serial Research Loop with subagents

Status: accepted

## Decision

The Node server is the only authority for Research Loop state, revisions, budgets, execution, evaluation, recovery, and stop decisions. Pi and `pi-subagents` are used only for structured candidate generation and result analysis.

The first implementation is serial. Candidate files are returned as JSON, validated, and copied into immutable snapshots. Candidate and evaluator commands run through `JobCoordinator` in workspace-contained directories with a restricted environment. Only deterministic metrics may drive automatic stop conditions.

Each external phase is recorded as reserved, started, and completed/failed events in the workspace's private `research-records-v2.jsonl` under the global application state root. On startup and API access, the reconciler resumes non-terminal loops, consumes terminal job records, and marks missing agent runs as lost before an idempotent retry. Pausing waits for the current phase; cancelling stops active agent and job runs before becoming terminal.

Hidden supervisor sessions are stored beneath the workspace's private `research-sessions/<loop_id>` state directory and are excluded from normal conversation navigation.

## Consequences

- Browser closure does not stop orchestration.
- Late subagent output cannot directly mutate loop state or formal metrics.
- New loops use an explicitly selected workspace benchmark script. Its SHA-256 is fixed at registration and rechecked before baseline and candidate evaluation. Preflight runs the baseline before a loop becomes ready; candidates are measured by the same script. The script reads `PI_SCIENCE_SUBJECT_DIR` (workspace for baseline, candidate outputs for experiments) and writes `{ "metrics": { "name": 1.23 } }` to `PI_SCIENCE_EVALUATION_PATH`. `PI_SCIENCE_BASELINE` distinguishes the runs. The legacy `builtin:result-json` evaluator remains available for existing API-created loops, but the UI no longer auto-approves it as a new benchmark.
- A fixed script is a measurement boundary, not a security sandbox. Candidate, baseline, and evaluator jobs now require a fail-closed local OS sandbox; this protects job subprocesses, not the Pi supervisor or arbitrary extensions. Windows enforcement still requires validation on a real host.
- Parallel candidates and LLM-judged stop metrics remain out of scope until serial recovery and security behavior are proven in production.
- Workspace rename/delete is rejected while research or jobs are active.
