---
name: scheduled-tasks
description: Create, approve, run, and monitor durable scheduled literature-digest tasks through the pi-science control plane HTTP API (/api/scheduled-tasks/*). Covers URL-encoded cwd calls, the mandatory human approval gate before sensitive egress, manual runs with 202 + polling, and revision-conflict or scheduler-unavailable handling. Use when the user wants a recurring literature digest (cron/interval/once) or asks about its runs.
version: 0.1.0
license: Apache-2.0
category: automation
requirements:
  - name: curl
    kind: command
    description: All scheduled-task operations are HTTP calls to the local control plane.
  - name: pi-science-control-plane
    kind: service
    description: The pi-science server must be running; default base URL http://127.0.0.1:8787 (override with PI_SCIENCE_PORT).
risk: medium
---

# Scheduled tasks (durable literature digests)

You operate the server-side scheduled-task system **only through its HTTP API** on the local
pi-science control plane. The server is the single source of truth for tasks, runs, attempts,
approvals, and schedules. You never touch state files yourself.

Set up once per session:

```bash
BASE="http://127.0.0.1:${PI_SCIENCE_PORT:-8787}"
```

## Hard prohibitions (never violate)

- **Never read or write SQLite files directly** (`<workspace>/.pi-science/**/*.sqlite` or any DB
  file). The API is the only access path; direct file edits corrupt the durable scheduler.
- **Never edit legacy JSON state** (`<workspace>/.pi-science/scheduled-tasks/**/*.json` from the old
  prototype). If you see those files, report their existence to the user; do not import, rewrite,
  or delete them.
- **Never create shell or arbitrary-command tasks.** The only executor kind is `literature_digest`.
  There is no shell executor, no `job_command`, no command array — the API rejects them by design.
  Never try to smuggle commands through `query`, `instructions`, or `output.relative_root`.
- **Never auto-approve.** Approval of sensitive egress is always an explicit human decision made by
  the user in this conversation. Do not auto approve, pre-approve, batch-approve, or treat any
  phrasing as approval that is not one.

## Step 0 — confirm availability

Every route except `status` requires a workspace `cwd`. **Always pass `cwd` URL-encoded** with
`curl -G --data-urlencode "cwd=$PWD"`. A raw query string with an unencoded `$PWD` inside it breaks
the moment the path contains a space — never write one.

First check that the durable scheduler is available:

```bash
curl -s "$BASE/api/scheduled-tasks/status"
```

If the response reports the feature disabled, SQLite not ready, or the runtime stopping, tell the
user plainly that the durable scheduler is unavailable and stop. Do not fake results and do not
fall back to writing files yourself.

## Step 1 — list tasks

```bash
curl -s -G "$BASE/api/scheduled-tasks" --data-urlencode "cwd=$PWD" --data-urlencode "limit=50"
```

Paginate with the returned opaque `next_cursor` (pass it as another `--data-urlencode "cursor=..."`
parameter). Each summary includes `task_id`, `revision`, `approval_status`, `next_run_at`, and the
latest run.

## Step 2 — create a task

```bash
curl -s -X POST -G "$BASE/api/scheduled-tasks" \
  --data-urlencode "cwd=$PWD" \
  -H 'content-type: application/json' \
  -d '{
    "name": "Daily literature digest",
    "schedule": {
      "type": "cron",
      "expression": "0 9 * * 1-5",
      "timezone": "Asia/Shanghai"
    },
    "executor": {
      "kind": "literature_digest",
      "config": {
        "query": "single-cell RNA sequencing quality control",
        "providers": ["pubmed", "arxiv"],
        "instructions": "Focus on reproducibility and sample quality metrics.",
        "max_results": 30,
        "language": "zh-CN"
      }
    },
    "output": { "relative_root": "reports/literature" },
    "retry": { "max_attempts": 3, "initial_backoff_seconds": 30, "multiplier": 4, "max_backoff_seconds": 600 },
    "misfire_policy": "coalesce_latest",
    "concurrency_policy": "forbid"
  }'
```

Field notes:

- `schedule.type` is `once` (with a `run_at` timestamp), `interval`, or `cron`. Cron expressions are
  exactly 5 fields. `timezone` must be a valid IANA name. Use `POST /api/scheduled-tasks/preview`
  first if the user wants to see upcoming fire times.
- `executor.kind` must be the literal string `literature_digest`. Its `config` takes `query`
  (required), `providers` (at least one), optional `instructions`, `max_results` (1–100), and
  `language` (`zh-CN` or `en`).
- `providers` may contain **only**: `pubmed`, `genbank`, `arxiv`, `pubchem`, `uniprot`. No other
  provider id exists in this pipeline; anything else is rejected.
- `output.relative_root` is a relative directory inside the workspace where immutable per-run
  reports are written.
- `misfire_policy` is `coalesce_latest` or `skip`; `concurrency_policy` is always `forbid`.

Success returns `201 Created` with the full task: `task_id`, `revision`, and an `approval` object
(`status`, `scope_hash`, `categories`, `terms`). Read `approval.status` before doing anything else.

## Step 3 — approval gate (mandatory, human in the loop)

- `approval.status: "approved"` → nothing to do; proceed.
- `approval.status: "none"` → no sensitive terms were detected; proceed.
- `approval.status: "pending"` → the query matched sensitive-term categories and **all network
  egress for this task is blocked until a human explicitly approves it**.

When pending you must:

1. Show the user the exact `query`, the detected `categories`, and the matched `terms` verbatim from
   the task's `approval` object.
2. Wait for the user to explicitly say they approve this egress. **"Create this task", "set it up",
   "go ahead with the schedule" are NOT approvals of sensitive egress.** If the user has not
   unambiguously approved after seeing categories and terms, do not call approve. 不自动批准。
3. Only after explicit user approval, POST:

```bash
curl -s -X POST -G "$BASE/api/scheduled-tasks/<task_id>/approve" \
  --data-urlencode "cwd=$PWD" \
  -H 'content-type: application/json' \
  -d '{"expected_revision": 12, "approval_scope_hash": "<scope_hash from the task DTO>", "categories": ["clinical-identifier"]}'
```

`expected_revision`, `approval_scope_hash`, and `categories` all come from the task you showed the
user. If the API answers `409 SCHEDULED_TASK_APPROVAL_SCOPE_CHANGED`, the task changed since you
read it: re-GET the task, show the new categories/terms again, and ask the user anew.

## Step 4 — run now

```bash
curl -s -X POST -G "$BASE/api/scheduled-tasks/<task_id>/run" --data-urlencode "cwd=$PWD"
```

A `202 Accepted` response means the run was created durably but has **not** finished. Poll it:

```bash
curl -s -G "$BASE/api/scheduled-tasks/<task_id>/runs/<run_id>" --data-urlencode "cwd=$PWD"
```

Keep polling (a few seconds apart) until `status` reaches a terminal value — `succeeded`,
`failed`, `cancelled`, or `interrupted` — or until the user tells you to stop. Fetch attempt detail
with `GET .../runs/<run_id>/attempts`. Report the final status honestly, including failures.

A `409 SCHEDULED_TASK_APPROVAL_REQUIRED` here means the task still needs the Step 3 gate first.

## Error handling rules

| HTTP | code | What you do |
| --- | --- | --- |
| 409 | `SCHEDULED_TASK_REVISION_CONFLICT` | Someone else changed the task. Re-GET it, read the new `revision` and new content, then decide again (with the user if the change matters). Never blind-retry your stale edit over the newer data. |
| 409 | `TASK_HAS_ACTIVE_RUN` | A run is still active. Tell the user, offer to cancel it via `POST .../runs/<run_id>/cancel`, then retry the original operation. |
| 503 | `SCHEDULED_TASKS_DISABLED`, `SCHEDULED_TASKS_SQLITE_DISABLED`, `SCHEDULED_TASKS_SQLITE_UNAVAILABLE` | All three mean the same thing: the durable scheduler is unavailable. Say exactly that to the user, quote the code, and stop. Do not simulate, cache, or fall back to local files. |
| 400 | `INVALID_SCHEDULE`, `INVALID_TIMEZONE`, `INVALID_EXECUTOR_CONFIG`, `INVALID_CURSOR` | Fix the payload (or pagination cursor) and retry once. |
| 403 | `WORKSPACE_FORBIDDEN` | The cwd is not a registered workspace. Ask the user which workspace to use; do not guess paths. |
| 404 | `SCHEDULED_TASK_NOT_FOUND`, `SCHEDULED_TASK_RUN_NOT_FOUND` | Wrong id or cross-workspace id. Re-list to find the right one. |

The same revision-conflict discipline applies to PATCH, pause/resume, delete, and approve: every
mutation carries `expected_revision`, and a `409` always means re-read, re-decide, re-send.
