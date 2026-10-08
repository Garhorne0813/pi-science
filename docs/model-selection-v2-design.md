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
reads and replace only their owner's cache. Existing sessions never fall back
to the default when their selection is missing or unavailable. Scope/version
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
