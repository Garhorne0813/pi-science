# ADR: Conversation Navigation and Artifact Lineage

- Status: accepted (implemented across two milestone commits on `feat/conversation-navigation-artifact-lineage`)
- Date: 2026-08

## Context

Long research conversations accumulate hundreds of messages and dozens of
generated files. Users need durable navigation (bookmarks, reading position,
attention states) and a minimal versioned dependency view of artifacts —
without sacrificing the workspace-first, Node-owned, JSON/JSONL-only data
model.

The plan `docs/refactoring-plan.md` and the comparative study
`docs/reverse-cs-inspiration.md` identified five candidate directions; this PR
delivers the first two as complete loops:

1. **Conversation navigation** — durable bookmarks (with agent proposals that
   require explicit acceptance), persisted reading position, and a minimal
   Attention Queue (Needs you / Running / New).
2. **Artifact versioned lineage** — exact versioned input references,
   supersession, and an intermediate/deliverable/unspecified classification,
   surfaced in the file inspector.

## Decision

### Conversation navigation

- Canonical state lives in the workspace-local file
  `.pi-science/conversation-navigation.json` (schema_version 1). All writes go
  through `withFileWriteLock` + `writeJsonAtomic`.
- The state stores **no absolute paths, no opaque cursors, no transcript
  copies** beyond a capped 500-char bookmark quote. The `before` locator for a
  bookmark or read anchor is re-resolved from the session JSONL on every read,
  so appends never leave stale cursors behind.
- Legacy `.pi-science/bookmarks.jsonl` rows are folded read-only on first use
  (deterministic `legacy-<sha256>` ids, `origin: "legacy_auto"`,
  `status: "proposed"`), materialized into the JSON on the first write, and the
  legacy file is never deleted or rewritten (code rollback keeps the old path).
- Malformed JSON or an unsupported future `schema_version` fails closed:
  reads error, writes are refused — never a silent reset.
- Bookmark quote/role are resolved by Node from the session JSONL; the client
  cannot inject text. Per-session cap: 500 non-rejected bookmarks; label ≤ 160,
  quote ≤ 500 chars.
- Read state: `anchor_message_id`, `at_bottom`, `seen_snapshot_version`.
  `at_bottom=true && mark_seen=true` stores the CURRENT server-computed
  snapshot version (never client-supplied). `at_bottom=false` moves the anchor
  without clearing the seen snapshot, so browsing history cannot clear the
  "New" badge.
- Attention (`GET /api/attention`): `needs_you` (runtime pending interaction)
  > `running` (busy runtime) > `unread` (read state exists AND latest visible
  message is assistant AND snapshot differs from seen) > `idle`. Sessions
  without any read state are `idle`, so upgrading never marks the whole
  workspace unread. Limit default 30, max 100.
- Message index: `GET /api/sessions/:id/messages/index?roles=all` extends the
  index to assistant messages with visible text (tool results never qualify);
  the default (no `roles`) keeps the user-only minimap behavior. Only
  index-confirmed persisted message ids may be bookmarked — live temporary
  block ids never show a bookmark action.
- All navigation routes are Node-native (`node-control-plane`) and gated on
  `nodeSessions || nodePiManager`; the old keyword-based `POST /api/bookmarks`
  became a proposal generator (never auto-accepted).
- Session delete also cleans up that session's bookmarks and read state.

### Artifact lineage

- Canonical store stays `.pi-science/artifacts.jsonl`. Manifest v2 is purely
  additive: `schema_version: 2`, `inputs: Array<{artifact_id, version} | string>`
  (max 100 versioned refs), `supersedes: {artifact_id, version} | null`,
  `classification: "intermediate" | "deliverable" | "unspecified"`.
- Legacy v1 rows (no `schema_version`) are normalized in-memory to
  `classification: "unspecified"` with string inputs preserved as unresolved;
  files are never rewritten.
- Duplicate rows for the same `artifact_id + version` (verification updates
  append a refreshed row) collapse to the **last** record — for reads, GET and
  lineage alike.
- Explicit `POST /api/artifacts/publish` defaults to `deliverable`; automatic
  write/edit discovery in `node-event-observer` writes `intermediate` with
  empty inputs.
- Publish validates relations against the workspace's own manifests: missing
  targets, duplicates, refs to the version being created, and over-limit
  inputs return 422. Because lookups are workspace-local, cross-workspace
  refs can never resolve. Superseding an OLDER version of the same artifact is
  the normal supersession flow and is allowed.
- `GET /api/artifacts/:artifact_id/lineage?version=` returns upstream
  (`consumes` / `supersedes`), downstream (`consumed_by` / `superseded_by`)
  and `unresolved_inputs` (legacy strings, which never form edges). No graph
  is materialized; each request folds the workspace JSONL.
- `GET /api/artifacts?path=&latest=1` resolves the latest manifest for a path
  (used by the inspector).
- The inspector embeds an `ArtifactLineagePanel` above the provenance history:
  classification badge, exact version chips, grouped relations, click-to-open
  the related file. When a file has no manifest or the endpoint fails the
  panel renders nothing, so ordinary file history is never crowded.

## Compatibility and rollback

- New navigation state is a new file; rolling back the code simply ignores it.
  The legacy `bookmarks.jsonl` path remains untouched for old-code recovery.
- Artifact v2 fields are additive; old code's passthrough JSONL readers ignore
  them. Payload files and SHA-256s never change. No database downgrade.
- Each milestone commit is independently green (typecheck + focused tests +
  full suite), so either can be reverted as a unit.

## Non-goals (explicitly deferred)

- Background LLM bookmarker scheduling, `Plan ready` / unresolved review
  finding aggregation, a full Artifact Library page.
- SQLite/graph index under `.pi-science`, remote SSH job lifecycle, routines,
  MCP expansion, Python-side business state.
- Deep workflow skills (literature-review / figure-composer /
  traceability-review) — separate PR.
- Multi-user read cursors and cross-device actor identity (single-user
  local-first model; last-writer-wins is accepted).
- Persisted pending-interaction recovery across daemon restarts (Needs you is
  defined as the current runtime's in-memory pending state).

## Validation

- `pnpm typecheck`, `pnpm test`, `pnpm build` green on both milestone commits.
- Focused suites: contracts, navigation repository/routes, session
  repository/event hub/service, artifact manifest/routes/observer, inspector
  lineage UI, LiveSessionPage restore/bookmark flows, sidebar attention.
