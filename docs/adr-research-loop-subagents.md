# ADR: Durable serial Research Loop with subagents

Status: accepted

Current process and persistence boundaries: [Architecture](architecture.md#scientific-execution-and-research).

## Decision

The Node server is the only authority for Research Loop state, revisions, budgets, execution, evaluation, recovery, and stop decisions. Hidden Agent Core Workers running AgentHarness are used for structured candidate generation and result analysis. They do not own loop state or evaluation decisions.

The first implementation is serial. Candidate files are returned as JSON, validated, and copied into immutable snapshots. Candidate and evaluator commands run through `JobCoordinator` in workspace-contained directories with a restricted environment. Only deterministic metrics may drive automatic stop conditions.

Each external phase is recorded as reserved, started, and completed/failed events in `research-records-v2.jsonl` under the resolved project metadata root. On startup and API access, the reconciler resumes non-terminal loops, consumes terminal job records, and marks missing agent runs as lost before an idempotent retry. Pausing waits for the current phase; cancelling stops active agent and job runs before becoming terminal.

Hidden supervisor sessions use the same `agent-sessions/` Core v4 repository as conversations. Registry ownership and `agent-task-links/` associate them with their task before activation; they are excluded from normal conversation navigation. The supervisor capability is restricted to `read` and `subagent`, while project reviews have no tools.

## Consequences

- Browser closure does not stop orchestration.
- Late subagent output cannot directly mutate loop state or formal metrics.
- MVP evaluator support is intentionally limited to the built-in deterministic `result.json` evaluator.
- Parallel candidates and LLM-judged stop metrics remain out of scope until serial recovery and security behavior are proven in production.
- Workspace rename/delete is rejected while research or jobs are active.
