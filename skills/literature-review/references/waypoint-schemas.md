# Waypoint contract — recoverable scientific SOPs

This is the shared checkpoint contract for deep scientific skills in Pi-Science.
A deep skill runs as a **sequence of stages**; each stage records a durable,
schema-shaped waypoint so the work can be paused, reviewed, and resumed without
losing state.

## Durable waypoint log

Every deep skill appends its stage records to a workspace-local JSONL file:

```text
.pi-science/sop/<skill>/waypoints.jsonl
```

One JSON object per line, append-only, written atomically (same discipline as
`.pi-science/research-records-v2.jsonl`). The log is the **recovery authority**:
resuming the skill means reading the log, finding the last `completed` stage,
and continuing from the next stage. Do not rebuild stage state from conversation
memory.

## Waypoint record schema (v1)

```json
{
  "schema_version": 1,
  "skill": "figure-composer",
  "stage": "layout",
  "stage_index": 2,
  "status": "completed",
  "checkpoint": {
    "plan": "A (top) / B / C (bottom), 16:9, 300 dpi",
    "artifact_refs": ["figures/panel-a.png", "figures/panel-b.png"]
  },
  "confirmation": {"kind": "user", "at": "2026-08-14T00:00:00Z", "note": "layout approved"},
  "created_at": "2026-08-14T00:00:00Z",
  "updated_at": "2026-08-14T00:10:00Z"
}
```

| Field | Meaning |
| --- | --- |
| `schema_version` | always `1` |
| `skill` | the skill id (must match the directory name) |
| `stage` | stage id, one of the skill's declared stages |
| `stage_index` | 1-based position in the skill's stage list |
| `status` | `in_progress` | `completed` | `failed` | `needs_confirmation` |
| `checkpoint` | stage-specific summary: plan decisions, artifact references, metrics |
| `confirmation` | optional human gate record: `{kind: "user", at, note?}` |
| `created_at` / `updated_at` | ISO 8601 timestamps |

## Stage lifecycle rules

1. **One waypoint per stage**, written when the stage settles (not per step).
2. A stage that needs a human decision ends with `status: "needs_confirmation"`;
   after the user responds, rewrite the record to `completed` (same stage line,
   updated `updated_at` and `confirmation`). The skill must **stop and wait** at
   that gate — never proceed past a `needs_confirmation` record.
3. `status: "failed"` records the failure in `checkpoint`; the skill may retry
   a stage only when its convergence rules allow (see the skill's SKILL.md).
4. On resume: read the waypoint log, skip every stage at or before the last
   `completed`, and restart from the first `in_progress` / missing stage.
5. Never claim the work is complete until the final stage has a `completed`
   waypoint with the skill's declared output artifact verified.

## Convergence and stopping

Each deep skill declares in its SKILL.md:
- its stage list (ids + one-line purpose),
- its **convergence rule** (when to stop retrying — e.g. max rework rounds),
- its **completion condition** (what the final waypoint must contain),
- its **common failure modes** (how `failed` records are classified).

These belong to the skill, not to this shared contract.
