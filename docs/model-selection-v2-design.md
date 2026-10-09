# ModelSelection v2

This follow-up to PR #116 separates **new-conversation defaults** from the
**durable selection of an existing conversation**. Provider credentials,
provider availability and capability facts remain separate concerns. It does
not introduce ProviderView or remove the legacy Settings configuration projection.

## Ownership

| Action | Default selection | Existing sessions | New session |
| --- | --- | --- | --- |
| Save Settings → Agent default | Updated | Unchanged; no worker reload | Uses the saved default |
| Change Composer selection in session A | Unchanged | Only A changes | Uses the default |
| Choose a model in an unsent workspace draft | Unchanged | Unchanged; no session created | Uses that draft selection on first creation |
| Clear the default | Cleared | Unchanged | Requires an explicit draft model |

`ModelSelection` contains only `{ model: provider/model | null, thinking }`.
Context capacity, output limits and supported thinking levels come from the Core
catalog. Request schemas reject unknown fields and invalid thinking values;
selection writes reject unavailable models and unsupported thinking levels.
Clearing a default normalizes thinking to `off`. A session cannot clear its model.

## API

- `GET /api/model-selection/default`: lightweight default read, independent of
  model catalog construction and session workers.
- `PUT /api/model-selection/default`: saves only the default in the existing
  settings store. It never configures, replaces or reloads existing sessions.
- `GET /api/sessions/:id/model-selection?cwd=...`: reads the live or cold durable
  session selection. The response includes the requested `session_id`.
- `PUT /api/sessions/:id/model-selection?cwd=...`: uses the existing Agent Core
  configure operation, persisting only that session. Busy workers return 409;
  missing sessions return 404. Workspace validation applies to session reads
  and writes. No shared-settings write or global runtime reload follows.
- `GET /api/model-selection/catalog?cwd=...`: narrow Core-backed catalog read
  for the Composer. It avoids loading the legacy provider/settings aggregation.

Write bodies are the selection itself. Read/write responses use
`{ scope: "default", selection }` or
`{ scope: "session", session_id, selection }`.
Invalid requests return 400 and unavailable selections return 422.

The deprecated `PUT /api/settings/model` is an ownership-aware compatibility
adapter: with `session_id` it updates only that session; without it, only the
new-session default. It returns the legacy response shape and a `Deprecation`
header, and retains legacy thinking-level clamping. Canonical clients use the
new endpoints and strict validation.

## Client lifecycle and persistence

Settings uses explicit Save and retains failed drafts. Composer reads are
cached independently by default or by `(cwd, session_id)`; writes cancel stale
reads and replace only their owner's cache. A saved session model that becomes
unavailable is never substituted with the default. Scope/version
checks prevent a delayed session A mutation from changing session B's UI.

A draft selection is scoped to its workspace, retained after failed creation,
and consumed only by successful creation in that workspace. Session creation
passes both model and thinking. A draft with no explicit selection lets the
server read the current default at creation time.

Existing `config.model` and `config.thinking` become the new-session default;
no file migration is necessary. Previously selected session configurations
remain authoritative across worker shutdown and cold resume. Historical shared
writes may already have changed the default before this migration; an earlier
intended default cannot be reconstructed automatically.

Historical sessions with no durable lane model inherit the current global
default on cold activation, including its thinking level when none was saved.
They are not frozen to an inferred earlier default: there is no authoritative
model to reconstruct. Once Core persists a lane model, that selection wins on
subsequent activation even if the global default changes. An empty default with
no durable model fails activation with `invalid_model`; it does not guess.
This compatibility exception is covered separately from normal durable sessions.

Composer model options are memoized by the catalog model-array reference.
Context/stream updates do not rebuild model options or the menu's search/index
structures; a changed catalog still rebuilds them.

Runtime reloads needed for provider credentials and other configuration still
rebuild workers, preserving each session's durable model selection. The removed
model-broadcast argument cannot overwrite unrelated sessions.

## Verification

Native server tests exercise default → A → default unchanged → B inheritance,
subsequent default changes with existing workers intact, cold durable reads and
resume, invalid inputs, missing sessions, busy failures and clearing defaults.
Frontend regressions exercise cache ownership, unavailable models, request
identity, delayed failures, workspace drafts, failed-create retry and explicit
Settings Save. Browser checks cover the default controls, saved values and
unchanged Composer selection alongside responsive Settings/accessibility checks.

Verification on 2026-10-08: 15 contracts, 847 server (15 skipped), 1,264 frontend
and 28 skill tests passed. The final narrow-menu adjustment passed its 13 focused
frontend regressions; workspace typecheck, production builds, lint, visual test
typecheck and bundle budgets passed. Six browser checks passed across desktop
light/dark and 375 px mobile, including Settings accessibility and visible
Composer submenu bounds. The real 100-provider/10,000-model backend benchmark
passed all existing budgets (catalog median 107 ms, Settings median 1,171 ms,
event-loop maximum delay 212 ms, concurrent health p95 146 ms); repeated Settings
reads left persisted files unchanged. These benchmark numbers describe this
Linux test environment, not a universal device latency guarantee.

## Review follow-up: independent defaults and commit status

The Agent default panel now owns its Default API and Catalog API queries,
including the saved-model summary and capability facts. A pending or failed
`/api/settings/config` read affects only Context Management. Defaults remain
selectable, saveable and clearable through their dedicated endpoints.

The successful PUT response commits the default and updates its cache. Neither
compatibility-cache invalidation nor the subsequent Context Management refresh
can reject that acknowledgement. Failed persistence retains the draft for retry;
failed context synchronization instead shows an explicit saved-with-sync-warning
state. Retrying synchronization does not submit the model again.

The picker memoizes model/options indexes by catalog snapshot, looks up selected
models by ID, and defers normalized search updates. Search reuses folded keys,
collects at most the visible limit plus one match, and avoids scanning/filtering
when the menu is closed. A browser regression exercises 10,000 catalog entries,
rare-model search, saving while context loading is stalled, and a later context
failure. It enforces 2,000 ms ready/search, 250 ms maximum Long Task and 1,000 ms
total Long Tasks budgets on production Chromium; these are regression margins,
not network or frame-rate guarantees. Both picker and provider-inventory browser
budgets run in the Ubuntu CI job.

Selection availability already comes from fresh Core `getAvailable()` reads,
whose managed route projection filters credentials, enabled providers/models,
endpoints, bindings, model allowlists and endpoint health. Nine additional native
regressions verify invalidated custom/builtin resources disappear from the
selectable catalog and return 422 for selection writes without changing defaults
or existing sessions. No duplicate resource-list validation or ProviderView
migration was needed. Resource changes concurrent with validation still require
a future revision/concurrency contract.

Review validation on 2026-10-08: 1,268 frontend tests, 12 native selection-route
tests (including the nine new availability cases), the disk-backed capability
persistence regression and eight production-browser checks passed. Typecheck,
production builds, lint, visual typecheck and bundle budgets passed. The picker
measured ready/search at 900/421 ms on desktop and 623/693 ms on 375 px mobile;
maximum Long Tasks were 65/128 ms, within the committed budgets. Fixtures isolate
frontend work from network/backend latency. Browser coverage also verifies that
Escape dismisses the model menu without closing Settings. The existing Windows
capability-persistence integration test now has a 30-second timeout for its
multiple disk-backed reads; its assertions and separate performance budgets are
unchanged.

Review follow-up: the default PUT carries the picker workspace solely as a
capability-validation context; default ownership and caching remain global. A
regression covers incomplete Core entries enriched by migrated custom hints.
Composer searches use a deferred, memoized index and provider grouping uses a
Map. Its submenu mounts at most 50 models per page; pagination and search retain
access to the entire catalog. Separate 10,000-model desktop/mobile interaction
budgets cover opening, paging, search and Long Tasks, alongside default/session
isolation. These browser fixtures measure frontend work, not live inference.
