# Task execution and supervision

The host owns capabilities, admission counters and deadlines. Agent tool parameters
can narrow these permissions and limits; they cannot grant access to a connector,
change an inherited task scope, replenish an exhausted quota or extend a deadline.

## Host execution limits

Ordinary tasks need no budget setup call. The host applies operation timeouts,
cancellation, execution-count limits and child concurrency/depth ceilings.
`execution_budget` is no longer a model tool, and subagent schemas no longer
advertise per-kind or local budget parameters. Auto Research does not bind a
runtime research ID before executing.

The durable ledger remains an internal compatibility boundary for existing
execution grants, cancellation and recovery. Trusted host code can narrow it
through `ExecutionBudgetLedger.configure`; existing saved scopes and task
records retain their original constraints and are never reset on recovery.

All descendants spend against the same global limits. Each child also has a local
node, and every reservation checks and updates that node, all of its ancestors and
the root in one file transaction. Thus siblings cannot overdraw the root and a
grandchild cannot bypass its parent's local limit. `by_kind` supports `bash`,
`notebook`, `mcp`, `subagent` and host-bound `job` admissions; zero disables a kind.
Notebook counts are tool calls, not individual cells or scientific experiments.
A parallel/chain delegation reserves one admission for each requested child.

Reservations are keyed by operation, invocation, execution kind and local node.
Replaying the same admitted invocation after recovery does not spend again.
Failures retain their admission. Historical counters remain authoritative; missing
or corrupt inherited ledgers fail closed. Child-local changes leave sibling limits
alone. Limits can only shrink, including on reopen.

Defaults are 100 admissions and one hour per operation. Legacy host-bound
`research_id` scopes remain readable across continuation operations. The binding
and reservations serialize on the same scope lock. Query results include global usage, local usage, remaining admissions by
kind, cancellation and the effective deadline.

## Child permissions and local budgets

```json
{
  "agent":"researcher",
  "task":"Find supporting evidence using the permitted connector.",
  "tools":["read","mcp__papers__search"],
  "wait_seconds":0
}
```

The effective tool list is the intersection of the parent's current tools, the
role's declared tools and the optional per-delegation list. An explicit request
outside that ceiling is rejected. The initial list is saved with the task so a
later role edit or restart cannot widen it. Every child tool dispatch rechecks the
parent and current role; MCP checks again after waiting for a connector slot.
Project connector policy and explicit preauthorization remain authoritative.

A child has an independent worker/session and budget node. The depth ceiling is
two, parallel groups allow four tasks, and sequential chains allow eight. Child
execution has a ten-minute ceiling and can be shortened by either its local budget
or any ancestor. These limits include time waiting for model responses. A worker
monitors the durable ledger throughout its operation, including resumed work;
tool and process watchdogs enforce their own ceilings as well.

## Waiting, collection and stopping

`subagent.wait_seconds` limits the caller's wait, not the child's execution.
Omitting it waits for completion up to the execution ceiling; `0` dispatches in the
background. A wait that expires returns a `task_id`, `status: "running"` and the
execution deadline. It does not replenish or reset the child's budget.

Use `subagent_control` to supervise tasks owned by the calling session:

```json
{"action":"list"}
{"action":"status","task_id":"<returned task id>"}
{"action":"collect","task_id":"<returned task id>","wait_seconds":30}
{"action":"stop","task_id":"<returned task id>"}
```

Listing, inspecting, collecting and stopping consume no execution admissions, so
cleanup and result retrieval still work after the quota is spent. Collection can
resume an interrupted task under its saved deadline, budget, invocation identity
and tool ceiling, with current permission checks. Completed results are persisted
before delivery; collecting them again reuses the stored result. A stopped task
cannot be resumed. Another session's task IDs are rejected.

Stopping a task persists cancellation in its budget nodes, shuts down its workers
and recursively stops descendants. Explicit parent abort and parent worker exit
stop its outstanding tasks. A hard deadline also cancels work, rather than merely
returning a running descriptor. Existing execution/artifact records preserve
completed work. A parent with outstanding background work is kept out of idle eviction, and its
workspace remains busy until that work settles. A daemon crash leaves resumable
records; recovery does not silently
allocate a fresh budget.

## MCP scheduling

Each workspace/project/connector identity shares a FIFO admission queue across
worker processes: four active calls, at most sixteen queued calls and a thirty
second queue-wait limit. A cancelled waiter is removed. A dead process's slots are
reclaimed; a live process is not evicted just because a call is slow. Different
connector identities have independent queues.

After queue admission the worker rechecks parent/role authorization and connector
policy before sending the RPC. MCP request timeout remains connector-configurable
(default sixty seconds of active execution), separate from queue waiting and the
task deadline. The ten-second discovery budget and request timers pause during
network authorization for that connection only. Discovery starts after prompt
admission so browser responses and abort remain available. Authorization waits
are bounded to 120 seconds; task deadlines and cancellation remain hard limits. The
adapter adds no automatic retry for side-effecting calls. Tool results record queue
and execution durations. Cancellation is forwarded through the MCP protocol;
termination of work already accepted by a remote service depends on that service.

## Host-bound background Jobs

Trusted server code can call
`jobs.submit(cwd, body, {owner: budgetOperationId, nodeId: budgetNodeId})` to reserve
a `job` admission in the same tree. The binding is a separate host argument; JSON
request bodies and environment variables cannot select it. The coordinator saves
the binding with the job and rechecks it before launch. It bounds process lifetime
by the effective deadline and observes later ancestor cancellation/deadline
reductions, terminating the process and recording `cancelled` or `timed_out`.
Standalone Jobs submitted through the ordinary UI/API retain their own timeout and
sandbox admission; they are not silently charged to an unrelated agent operation.

## Validation

Budget tests cover ancestor/local/per-kind caps, durable replay and deadline
propagation. Supervision integration uses real session workers with a local model
endpoint to cover background collection, recovery and cancellation during model
inference. Scheduler tests use a separate worker process to verify shared capacity
and dead-owner reclamation. Job tests run real processes and verify budget-driven
termination. The opt-in DeepSeek acceptance uses the official API, model
`deepseek-flash` and reasoning effort `high`; its request audit and sandbox checks
remain enabled.
