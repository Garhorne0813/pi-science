# ADR: Conversation-first research workflows

Status: accepted for staged implementation

## Context

The conversation composer exposes five research starters: research loop,
optimize, compare, evaluate, and reproduce. The original implementation sent
all five through the same hard-coded `score/maximize` Research Loop setup.
That made distinct user intents look implemented while only changing their UI
labels.

## Decision

Conversation is the only place where a user starts a research workflow. The
workspace Research page remains the durable execution monitor, and Project
Knowledge only summarizes loops and receives promoted results.

Every starter is compiled into an explicit task type:

| Task type | Execution plan |
| --- | --- |
| `research_loop` | System-planned iterative loop driven by evidence convergence |
| `optimize` | System-planned iterative loop with an inferred measurable objective |
| `compare` | Structured task in the current conversation |
| `evaluate` | Structured task in the current conversation, requiring a result/run/artifact target |
| `reproduce` | Structured task in the current conversation, requiring a source experiment and non-destructive output |

Only iterative plans create a `ResearchLoop`. The loop stores `task_type` so
the proposer, monitor, event log, and future experience retrieval can retain
the user's intent instead of inferring it from the title.

The first stage remains serial and deterministic. Parallel proposal pools,
cross-workspace experience retrieval, LLM/VLM stop metrics, and evaluator
co-evolution remain out of scope until recovery and evaluation behavior is
proven through real use.

## Interaction contract

1. The user selects a workflow in any conversation, including an existing one.
2. The next message is posted to the intent compiler with `mode` and
   `objective`.
3. Conversation plans are transparently expanded into a structured prompt and
   sent with the user's attachments and workspace references.
4. Iterative plans show a plain-language execution summary. The user confirms
   local execution, but does not configure metrics, directions, budgets, or
   stopping parameters. Those remain internal execution details inferred from
   the goal; exploratory loops fall back to evidence quality and convergence,
   never to a user-facing generic `score` field.
5. Confirmation registers a versioned deterministic evaluator, creates the
   typed loop, runs preflight, and starts it.

## Boundaries

- Conversation workflows may read the current conversation and selected files.
- Candidate execution remains workspace-contained and must not overwrite the
  source experiment.
- Research experience records do not enter general conversation memory.
- Loop results may enter Project Knowledge only through a future promotion
  proposal carrying evaluator, run, and artifact provenance.

## Next stages

1. Add result promotion into the knowledge review inbox.
2. Build a workspace-scoped experience index containing successful and failed
   candidates for proposer retrieval.
3. Add calibrated evaluator proposals and human approval for evaluator version
   changes.
4. Add isolated parallel executors only after serial production behavior is
   stable.
