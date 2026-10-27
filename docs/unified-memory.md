# Unified Memory

Memory replaces the ledger/Project Knowledge product and APIs. The existing
SQLite StateStore and its single Worker own the records, sources, revisions,
review events, proposals, indexes, cursors and durable background runs.
Migration `0005_unified_memory.sql` creates an empty Memory domain. It does not
read, migrate, overwrite or remove existing ledger/project-state data. Back up
those old files separately if needed; they are no longer served as Memory.

## Upgrade from Ledger / Project Knowledge

**Breaking change:** migration 0005 starts with empty Memory state. Existing
ledger/project-state approval flags are not imported as new scientific approvals.
Old files remain untouched; back up both application state and workspace metadata
before upgrading. Stop the old application for a stable file snapshot, then run
from this checkout:

```bash
pnpm export:legacy-memory /absolute/workspace /absolute/new-legacy-memory-export.json
```

The exporter reads the current metadata root's `memory/ledger.json` and
`project-state.json` without modifying them, records checksums plus exact base64
bytes and UTF-8 previews, marks the bundle `unreviewed_legacy`, and refuses to
overwrite a destination. It does not need a model key and never enables/imports
Memory. Review the export, recreate useful entries with their original verifiable
sources in the Memory editor, and approve scientific content as new exact
versions. There is no automatic bulk-import path or reuse of legacy approvals.
Retain the original files/export until the reviewed transfer is verified.

## Enabling and reviewing

Memory, Extraction and Dream start disabled. Enable Memory in application
Settings → Memory, then independently opt into Extraction or Dream.
Persistent SQLite state is required outside tests; disabling it with
`PI_SCIENCE_SQLITE_STATE=0` prevents enabling Memory.

The application currently has a trusted local owner, authenticated through the
existing control-plane token/cookie. Model-supplied owner/origin/reviewer strings
never grant authority. Main Agent tools use signed, session-bound capabilities;
delegated/confined runtimes receive no Memory capability in this release.

Smart review auto-accepts only a closed grammar of enumerated reply-language,
reply-format/verbosity and UI-theme preferences with a recognized presentation
title and reliable sources. Mixed, unrecognized or operational wording requires
review; a generic format keyword never grants acceptance. Ambiguous content, scientific observations/findings/decisions and changes
to manually authored or approved records require human review. The semantic
check is deliberately restrictive; it is not a scientific truth classifier.
All-manual queues every Agent/background change. Direct user edits of ordinary
low-risk memories still save immediately. Changing back to Smart never approves
existing pending records or proposals.

Approvals require the displayed content revision and SHA-256 hash. Status-only
approval preserves that exact content revision. Editing an active protected
record creates a proposal; the approved version stays effective until the
proposal wins its atomic revision/hash comparison. Competing proposals become
stale. Rejecting a proposal leaves current content intact. Approval means project
adoption, not proof of scientific truth.

Sources must resolve to existing messages, sessions, execution records, published
Artifact versions, authorized Memory records or workspace files. Source project
IDs and canonical message locators preserve Profile provenance across projects.
Memory-to-memory sources require an active accepted upstream record and pin its
content revision and hash. Validation traverses a bounded, cycle-checked evidence
chain; upstream edits, archive/rejection or deletion invalidate active dependents
transitively. Approval rechecks these pins atomically; old unpinned references
require a new revision rather than silently binding to current evidence.
File/Artifact digests are checked again on approval and automatic recall; changed
or missing evidence removes the record from automatic recall and flags it for
review. Literature can be cited through a local file or published Artifact;
remote citation strings are not silently treated as verified evidence.

## Scope and recall

- Profile belongs to the local owner and is visible across authorized projects.
- Project uses the stable project ID, not its current filesystem path.
- Artifact binds a project, Artifact ID and optional version; automatic recall
  requires an explicit matching Artifact context.
- Frame binds a Session. It survives closing/reopening and compaction. Successful
  Session deletion cleans it; startup reconciliation repairs interrupted cleanup.

Automatic recall runs without another LLM call, using the current user task and
small Profile context. The main Harness recomputes reference context on generation
and restores its query after reopening. The UI opening an Artifact does not itself
trigger a new Agent generation; tools can explicitly search/read Artifact memory.

Chinese character unigrams/bigrams and preserved ASCII/code identifiers feed
FTS5/BM25 and Jaccard ranking, combined with reciprocal-rank fusion. Owner,
project, status, category and Artifact constraints restrict eligible candidates;
hidden records cannot consume result slots. Defaults cap task recall at six,
Profile at twelve/approximately 1,600 tokens, and total context at approximately
2,500 tokens. The token bound uses a conservative character estimate. Recall is
ephemeral lower-priority reference data, inserted before the actual conversation
through the Harness context transform. Raw memory never enters the system prompt
or the durable transcript; the system contains only a static distrust policy.
Role-like delimiters in JSON data are escaped. This boundary regression does not
claim that model behavior is immune to every prompt injection. The per-project and per-category
recall switches on the Memory page can tighten the global switch. Owner-wide
settings live in application Settings → Memory, accessible without opening a
project. Memory itself has Memories, Pending review and Run history tabs, plus
a shortcut to its application settings. Unapproved scientific records
remain explicitly labeled in manual tool/UI searches and are excluded from
automatic confirmed context. An FTS error is surfaced instead of silently
claiming BM25 worked.

A small offline regression corpus compares Chinese/mixed-language top-one
retrieval with raw `unicode61` FTS5. It is a regression gate, not a general search
quality claim.

## Settings and record presentation

Settings → Memory is owner-wide. With Memory disabled, its dependent controls
collapse. Extraction and Dream independently reveal their own model and policy
fields. Dream's schedule/limits appear only while Dream is enabled; window start,
end and time zone appear only while its window restriction is enabled. Idle
minutes depend on Require idle, trigger interval on Interval mode, and the
once-per-window control on an automatic trigger. Window/idle gates still apply
to manual Dream admission. Collapsing controls preserves values; changes take
effect after Save and its settings-revision comparison.

Memory records use a compact title/status/scope/kind and two-line preview.
Expanding reveals full text, sources, content version, review state and history.
Editing and history open in a responsive, focus-trapped dialog/drawer; editor
drafts are keyed by record/revision and reset across record changes. Proposals
show full structured content, including title/kind/category/evidence and source
versions/hashes, with changed fields marked. Missing current content blocks approval.
Explicit Agent searches return previews only (at most 20 within approximately
6,000 serialized characters); full bodies/sources are fetched by ID on demand.
Edit/archive/hard-delete live in the more-actions menu; deletion retains explicit
confirmation. New review candidates expose approve/reject only after expansion.
Changes to existing records show current/proposed content and proposal status.
Pending review counts include records and proposals. Scientific pending records
remain visible with explicit status and are excluded from automatic recall.

## Filtering, sorting and pagination

The Memories tab combines keyword search with status, kind, scope and category
filters; category filtering appears when categories exist. The sort menu offers
recently updated/recently created and, when searching, relevance. Mobile screens
keep the record list visible and open filters in a modal bottom sheet. Choices
remain a draft until Apply; closing/Escape discards edits, and Reset clears only
the draft filters while preserving the search. The sheet traps focus and keeps
its action footer visible above the safe area. Changing search, filters or sorting resets to the
first page; Clear filters restores the default view. Query state is kept in the
page URL so reloads retain the selection. Matching totals, an empty state and
previous/next controls accompany 20-record pages.

`GET /api/memory/records` accepts `q`, `status`, `kind`, `scope`, `categoryId`,
`sort` (`updated_desc`, `created_desc`, `relevance`), `page` (starting at 1) and
`pageSize` (default 20, maximum 100). `approved` is an additional status filter for
active, human-approved records. The response contains `records`, `total`, `page`,
`pageSize`, `totalPages` and `sort`. Filtering, relevance matching and sorting run
on all authorized matches before pagination, with a stable ID tie-breaker. Empty
results have page 1; pages past the end clamp to the last page. The former
100/200-result caps remain only in internal candidate retrieval, not human
browsing; Agent tools apply the smaller preview budget described above, and
automatic recall keeps its independent context limits. This is not a
large-dataset performance guarantee. Pending-review responses include current
proposal content independently of the browser's filters/page.

## Extraction and Dream

Extraction checks persisted turns for a useful increment. It batches up to thirty
messages, limits source text and outputs, and uses an independent configured model
without tools. Its durable logical key contains project, Session and watermark.
Facts, review proposals and the success cursor commit atomically. Failure leaves
the cursor unchanged. Duplicate low-risk facts are suppressed; conflicting
same-title extraction produces a review proposal. Existing manually authored or
approved content cannot be silently overwritten.

Dream independently consolidates stored authorized memories. It does not require
Extraction. Manual/idle/interval/window triggers are supported, including optional
window restrictions on idle and interval modes. Configure an IANA time zone;
fixed numeric offsets are rejected. Cross-midnight windows belong to their opening
local date. DST gaps move to the first valid minute; repeated boundaries use the
earliest start/latest end. Equal start/end is invalid; disable the window for
explicit all-day permission. A new run must fit its maximum runtime plus a safety
margin before the window closes. Missed windows are skipped, not caught up.

Default Dream behavior is suggestion-only. `auto_low_risk` has a narrow whitelist:
archive exact duplicate, unprotected, non-scientific preference/workflow records.
It never automatically edits approved science or manual records. All-manual
forces suggestion-only. Run plus source links retain Dream provenance.

Runs, claims, lease tokens, deadlines, cancellations, usage and skip events are
persisted. A reclaimed lease belongs to the same logical run; an old worker's
output cannot commit. Queued/active disablement, cancellation, deadline expiry,
new main-task work and changed review policy are checked before result commit.
The scheduler monitors active conversation operations and Jobs conservatively;
errors prevent scheduling. It is an in-process scheduler and cannot wake a sleeping
computer or run after the server exits. Skips do not consume a window's run slot.

Extraction and Dream share one owner's UTC-day token and USD budget, with one
concurrent background model call. Reservations use configured model prices and
bounded input/output. Each claim reserves quota before provider dispatch.
Migration 0006 journals every physical claim/lease separately on its UTC admission
day, so cross-day retries and lease recovery retain earlier reservations and
charge the new call to its own day. Migration 0007 records whether each lease was
actually dispatched and reconciles usage on scheduler startup/ticks, history
reads and admission. For terminal, expired or superseded leases, unused claims
release their token/USD holds. Dispatched attempts with unknown spend clear their
holds and retain the conservative amount as explicit **estimated usage**, which
still counts toward that attempt's UTC-day budget; elapsed time is not evidence
that a provider call was free. Known usage, including a late response after
cancellation or lease recovery, replaces the estimate for that lease without
reviving the run or authorizing stale results. Measured settlement is idempotent.
The dispatch marker precedes the external call, so a crash in that narrow gap is
conservatively estimated. v6 outstanding holds have no dispatch proof and migrate
as potentially dispatched, never silently released. Run history distinguishes
measured, estimated and in-flight reserved amounts. Legacy snapshots are
backfilled conservatively on their known original start day because individual
old attempt dates were not recorded. Cooldown/interval/increment checkpoints and
queued recovery use dedicated durable queries, never the UI's truncated history.
A bad workspace is logged and skipped independently during scheduling. Events
retain an allowlisted error code (for example ENOENT, EACCES or SQLITE_BUSY),
failure stage, consecutive count and next retry time; raw exception messages,
paths and stacks are excluded. If the database cannot store the event, a safe
structured console warning retains the project ID, code and stage. Consecutive
failures use persistent exponential backoff from one minute up to one hour;
success, a real project interaction, or an admitted manual run/explicit retry
resets it. Explicit requests still obey all normal review, idle, window and budget
gates. Schedules are retained so a
restored workspace can recover; passive UI polling does not reset backoff.
Terminal runs cannot be cancelled; repeated cancellation is idempotent.
A failed logical run can be explicitly retried at most twice within the applicable
window and remaining budget. A force scan needs explicit confirmation and bypasses
only the window/no-increment gates, never authorization, review or resource limits.
No live paid provider was needed for the automated tests; production behavior
still depends on a working configured model and its reported usage.

## Retention, backup and unrelated workflows

Archiving is reversible lifecycle metadata, not physical deletion. User-only hard
deletion removes record content, revision/source rows, review events, proposal
rows, FTS/recall entries and corresponding background snapshots. Operation
idempotency keys retain content-free tombstones to prevent retry resurrection.
Sessions, exports and backups are independent copies; deletion does not promise
cryptographic erasure of old SQLite/WAL pages or external backups.

`SqliteStateStore.backup(path)` uses SQLite `VACUUM INTO` to capture committed WAL
content consistently into a new destination. Restore only while the service is
stopped. Memory's UI JSON export is an interchange/audit export, not a replacement
for a whole-StateStore backup.

`PROJECT.md` stays an ordinary project document, exposed through
`/api/project/document`. It is never rewritten when memory is approved. Run,
Artifact, Provenance, notebook execution, Skills and execution/file approvals
remain independent. Historical research archives remain under Run history and
`/api/project/archives`; the old Memory/Knowledge APIs return 404.

The previous `harness/KNOWLEDGE.md` tree is removed. Scientific format/environment
references were retained under `skills/traceability-review/references/`; the figure
standard already exists in `publication-figures`.

## Verification

Run `pnpm typecheck`, `pnpm build`, and `pnpm test`. The Memory tests include
cross-worker writes, review races, mode changes during background runs, forged
sources, cancellation, lease recovery, evidence changes, hard deletion, WAL
snapshot restore, Chinese recall, cross-midnight and DST windows. The frontend
tests check exact-version submissions, conflict feedback and settings CAS.

Against an isolated running backend and its built frontend, run
`pnpm --filter frontend test:uat:memory`. The browser UAT verifies user creation, keyword search, editing, revision history,
archiving, deletion cancellation, hard deletion and the resulting 404/empty search.
It also verifies combined filters, complete-match totals, pagination, sorting,
empty results, the mobile filter sheet, human scientific approval, settings persistence, unchanged
`PROJECT.md`, and desktop/mobile layout.
It temporarily changes the isolated server's global Memory settings, restores
them in cleanup, and does not call a paid model.

### Live model validation

A separate DeepSeek Flash integration exercise on 2026-10-26 verified actual
Agent writes/search, both review modes, switching Smart to all-manual while an
extraction was running, extraction and Dream completion, and human approval of an
exact scientific content version. The exercise used artificial project data and
an environment-backed credential; the credential was not stored in the checkout.

The live exercise also covers proxy-side DNS when private destinations are
explicitly permitted (strict public-only validation still fails closed), adaptive
background output budgets, known failure-spend accounting, historical message
sources bounded to Dream's collected evidence, and normalization of absent
optional LLM fields. Required fields and unknown fields remain strictly validated.
Model-generated candidates still require review of their content and provenance;
a successful run does not establish the correctness of every proposed statement.
