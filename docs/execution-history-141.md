# Execution history (#141)

The Runs surface now defaults to the session when entered from its conversation
rail. Workspace entry remains workspace-wide. `session_id` in the Runs URL
preserves that context. Session entry defaults to the timeline; workspace entry
defaults to a session-grouped list. `scope=workspace` temporarily broadens it while retaining
the session for switching back. Session membership requires an exact recorded
`correlation.session_id`; unassociated records belong only to workspace scope.

## Query and display contracts

`GET /api/executions` accepts `limit` (1–1000), `offset` (nonnegative integer),
`session_id`, `kind`, `status`, `search`, `from`, `to`, and `target_id`. Time bounds
are inclusive and test intersection with recorded execution intervals, so a
09:00–12:00 job is included in a 10:00–11:00 window. Active intervals end at now;
unknown starts cannot establish overlap. Terminal records without an end can
establish only their known start instant. Invalid/backwards intervals are excluded
by time filtering and shown as unknown in the unfiltered timeline. The UI sends UTC ISO timestamps converted from the
user's local datetime input. Search examines recorded request, result, correlation,
file, and artifact evidence before pagination. Ordering is newest creation time
first, with execution ID as a deterministic tie breaker.

- `total`: all executions within the selected session/workspace scope.
- `filtered_total`: matches after search/type/status/time filters, before slicing.
- `executions`: the requested page; the UI uses 50 rows per page.
- `status_counts`: counts across the selected scope, before filtering/pagination.
- `completed_duration_ms` / `completed_duration_count`: sum of durations and number
  of records with valid start/end evidence; unknown durations are not zero runs.
- `target_offset` / `target_in_scope` / `target_matches`: locate the exact target in
  the filtered ordering or explain why it cannot be placed in that page set.

Scope, view, search, kind/status, time bounds, page offset, grouping, and execution
selection and narrow detail/browse state use URL state (`detail=0` keeps browsing
after automatic first-row selection, while explicit targets open details). Embedded conversation Runs uses `runs_view` for mode,
while `view=runs` continues to select the conversation surface. Browser history
and refresh restore state. Explicit targets are fetched independently by ID when
outside the page and never replaced by the first row. Notices provide explicit
page/filter navigation. Missing targets retain their URL and show an error.
Ordinary automatic or clicked row selections carry `selection=page`; Previous/Next
clears that selection and selects the new page's first record. Scope and filter
changes also reset ordinary selection. The page list query never includes the
selected ID: visible row selection uses existing records without refetching or
unmounting the timeline. Explicit off-page targets request location metadata
separately, preserving timeline zoom and collapsed groups. Explicit deep links
without this marker retain their exact target across pagination. An empty page
leaves ordinary selection empty. Search input commits to the URL after 300ms of
inactivity; URL changes, clearing and unmounting cancel pending edits. Page queries
consume TanStack Query's AbortSignal so obsolete requests are cancelled.

Additional metadata is optional in the shared schema to preserve compatibility
with existing callers/fixtures; the server always supplies it. Legacy inspector
queries still return arrays, and session inspectors request their session directly.

Lists show recorded session ownership, status, result/error previews, and output
counts. Session grouping and the timeline operate on the current page and say so.
The timeline uses a shared absolute timestamp axis, preserving overlap. Running
executions extend to now; terminal executions without valid start/end timestamps
are marked unavailable. Zero duration remains zero in the model, with a minimum
8px visual marker for discoverability. These bars express timing, never dependency.
Real major/minor tick grids share the absolute axis. Fit/zoom/scroll change
resolution, not timestamp evidence. Workspace groups can be collapsed; current
session scope has no redundant grouping switch. Selection reuses the detail panel.
Narrow layouts scroll the timeline within its
pane rather than expanding the document.

Output fallback combines stdout and tool/result previews, and stderr with errors,
deduplicating equal strings. Preview logs always report `complete=false`; Job logs
use the job store's truncation flags. Active log data refreshes and terminal updates
invalidate its view so an initially empty preview cannot remain stuck. Code,
output/errors, file hashes/artifact versions, and scalar environment details appear
before expandable raw JSON. The default summary shows code/command, input files,
result previews and actual output filenames/artifact versions. Environment, timing,
and raw evidence are collapsed. Advanced filters use disclosures with active hints
and clearing; the wider workbench devotes about 60% to browsing. Real session titles
come from the workspace session registry, with IDs as fallback. Direct Runs entry
loads an empty sidebar registry without opening/creating a conversation; unrelated
Files/Research lifecycle is preserved.

## Reproduction boundary

The operation is explicitly **Ask AI to attempt reproduction** and creates a
reviewable draft. Its evidence includes the recorded request/code, input and output
file hashes, artifact versions, environment, result, and correlation. It asks for
condition checks, explanation of missing inputs/environment/kernel state, and user
confirmation before execution; truncated code must not be guessed. It does not
claim to have run or verified anything.

This implements P0/P1 and the reproduction honesty/evidence and scaling groundwork
in P2. The umbrella issue remains open for an executor that restores versioned
inputs and environments, isolates state, confirms the execution, and compares
outputs/artifact hashes. Arbitrary tools and stateful kernels do not yet have the
recorded conditions required to promise deterministic reproduction. Experiment
DAGs remain future work; no relationships are inferred from chronological order.

## JSONL performance

An initial isolated synthetic local benchmark seeded one valid start event per execution, then made
three full-history search queries with offset 100 and limit 50 (Node 24.19).
Before caching, repeated 50,000-event/16.8MB queries took 466–475ms. After a bounded
materialization, repeated queries took 29–30ms (cold read 447ms); 10,000-event
queries took 5–6ms warm versus 91–113ms before. These initial measurements precede scope summaries; a later run concurrent with
the full suite measured 86–88ms warm and 1400ms cold at 50,000 events. Timings depend
on process load. These are illustrative measurements,
not production performance guarantees.

JSONL remains authoritative. The cache skips repeated read/schema validation/event
reduction while the inode/size/nanosecond modification and change timestamps match.
Writes invalidate it; external changes are detected on the next query. A changed
file during reading is not cached. Retention is at most four workspaces and 100,000
records combined; response clones prevent callers mutating cached evidence. Search
and sorting still run over the selected materialization, while every append still
reads the event log for idempotency/sequence validation. Larger histories or write
rates warrant a durable incremental index rather than further cache expansion.

## Verification

Repository/API tests cover lifecycle and cache invalidation, strict session scope,
125-row pagination, search beyond the first 100, time bounds, malformed requests,
and preview fallback. Frontend tests cover navigation scope, server filtering,
paging reset, time range validation, waterfall positions/degradation, selection,
logs, files, and reproduction evidence. Browser tests exercise desktop/mobile
pagination and timeline/detail navigation, horizontal overflow, and axe checks.

## PR review follow-up

The issue's amended specification is implemented in this PR. Regressions cover
75th/125th-record provenance links, 404s, outside-scope targets, browser history,
overlap window edges/running/unknown intervals, default modes, ticks/zoom, collapsed
groups, keyboard interaction, long commands, and narrow-screen overflow. The failed
Linux SSE gate used an ambiguous all-page text locator after adding previews. Its
assertions now target the Notebook inspector; connection, hidden-tab recovery and
polling budgets remain unchanged.
