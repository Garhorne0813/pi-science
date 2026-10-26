# Unified Memory

Memory replaces the ledger/Project Knowledge product and APIs. The existing
SQLite StateStore and its single Worker own the records, sources, revisions,
review events, proposals, indexes, cursors and durable background runs.
Migration `0005_unified_memory.sql` creates an empty Memory domain. It does not
read, migrate, overwrite or remove existing ledger/project-state data. Back up
those old files separately if needed; they are no longer served as Memory.

## Enabling and reviewing

Memory, Extraction and Dream start disabled. Enable Memory in application
Settings → Memory, then independently opt into Extraction or Dream.
Persistent SQLite state is required outside tests; disabling it with
`PI_SCIENCE_SQLITE_STATE=0` prevents enabling Memory.

The application currently has a trusted local owner, authenticated through the
existing control-plane token/cookie. Model-supplied owner/origin/reviewer strings
never grant authority. Main Agent tools use signed, session-bound capabilities;
delegated/confined runtimes receive no Memory capability in this release.

Smart review permits only conservatively classified language, formatting and
similar low-risk preferences/workflows with reliable sources to activate without
review. Ambiguous content, scientific observations/findings/decisions and changes
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
reference data, never system instructions. The per-project and per-category
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
100/200-result caps remain only in legacy internal/tool search, not human
browsing; automatic recall keeps its independent context limits. This is not a
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
bounded input/output; unknown failure spend retains the conservative reservation.
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
