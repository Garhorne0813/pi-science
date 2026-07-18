# Science platform runtime contracts

Pi-Science stores platform metadata under the workspace `.pi-science/`
directory. The main records are append-only or versioned so an old session can
be inspected after a skill is upgraded.

| Record | File/API | Purpose |
| --- | --- | --- |
| Skill snapshot | `session-skills.jsonl`, `/api/sessions/{id}/skills` | Skill IDs, content digests, source, and enabled state at session start |
| Skill events | `skill-events.jsonl` | Skill load, lifecycle, tool outcome, and status telemetry without prompt secrets |
| Artifact Manifest | `artifacts.jsonl`, `/api/artifacts` | Hash, MIME, producer, inputs, environment, and verification for published files |
| PDF index | `pdf-index/<sha256>.json`, `/api/pdfs` | Reusable page-level text and evidence snippets |
| Jobs | `jobs/<job_id>.json`, `/api/jobs` | Provider-neutral submit/status/cancel/logs contract for local jobs |
| Result review | `result-reviews.jsonl`, `/api/result-reviews` | Read-only findings about citations and artifact verification |
| Bookmarks | `bookmarks.jsonl`, `/api/bookmarks` | At most two durable transcript breadcrumbs per run |

Remote MCP and model endpoints are described by catalog metadata before they
are used. A project policy can disable external services, allowlist domains, or
block data classes. Secrets are represented only by references; they are never
written into skill metadata, manifests, job logs, or endpoint responses.

