# Settings with Agent Core

This change branches from PR #115 at `6b4a8480`. The supplied
`prd-agent-core-runtime.md` describes an earlier revision with two runtimes;
PR #115 already uses Core 0.99.2 exclusively. This Settings change uses the
current implementation and does not repeat the migration or change dependencies.

The visual parameters follow [the frozen DeepSeek reference](ui/deepseek-harness-reference.md).
Grouped navigation, visible resource scope and explicit unavailable-provider
states also draw on ZCode's `packages/ui/src/SettingsPage.tsx` and
`settings/SettingsResourceGroup.tsx`. These are design references; upstream
source and branding are not copied.

## Organization

| Group | Pages | Purpose |
| --- | --- | --- |
| Workbench | General, AI Models, Agent, Progress | Device preferences, model connections, context policy and activity presentation |
| Capabilities | Skills, Extensions, MCP | Preserve the existing skill, subagent, web access and managed connector controls |
| Compute | Environments, Compute | Environment revisions and scientific execution resources |

The desktop sidebar identifies the workspace path or global scope. The content
explains that model credentials and configured model settings are shared; workspace skill,
MCP and compute resources use the workspace captured when Settings opened.
Changing scope remounts the content so drafts cannot cross workspaces.

General has three theme choices plus language and panel-order preferences.
AI Models retains canonical model-resource mutations, API key connection,
custom service discovery, credential replacement and disconnection. Configured custom providers stay visible regardless of credential or enabled
state, with connection repair, enable/disable and deletion actions. Service cards are searchable by service/model name and ID; mobile model rows
wrap and retain context/output labels. Model rows expose only the supported
thinking levels received from the catalog. OAuth-only services show Login
required and explain that subscription login is unavailable here.

Agent shows the configured model and its supported capabilities, with a link
to model connections. Model and thinking selectors stay in the composer. In this transitional PR,
composer changes configure the targeted durable session **and** update the shared
model/thinking settings used by new sessions. This is not independent default
and session ownership; the Agent page describes the shared configured model. A missing model stays unavailable; Settings does not replace it
or infer capacity from a cached value for another model.

## Compatibility and follow-up scope

This PR intentionally keeps `/api/settings/config` as a compatibility projection.
It does not establish that DTO as the long-term model configuration API. This is
Phase 0.5: Settings UX and runtime-fact consistency, not Model Configuration v2.

Model selection remains backed by the shared legacy settings contract in this
PR. `PUT /api/settings/model` with `session_id` commits that session's selection
and also writes the shared model/thinking config; without `session_id`, it writes
the shared config. Runtime configuration reloads also apply model changes to other loaded sessions
(after active turns settle); cold sessions without a saved selection read the
shared config. These existing behaviors are retained, not made session-local.
Separating default selection from per-session selection, dedicated model-selection
endpoints, backend-owned ProviderView availability and a ModelCatalog API are
follow-up work. The ownership regression explicitly characterizes today's shared
behavior so the future migration must change that expectation deliberately.

The current compatibility UI still interprets credential metadata and the lack of
subscription-login support. That policy is transitional; a backend ProviderView
should eventually return availability and permitted actions directly. Provider
existence is independent of this policy: missing/invalid credentials, disabled
state and unsupported login never hide a configured custom provider.

## Context policy

The old UI calculated an additional output reserve and overhead. Core uses
`ceil(contextWindow * (100 - thresholdPercent) / 100)`. Both now call the pure
`resolveAgentCompaction` function exported by contracts. Core's default threshold,
50–95% validation and `keepRecentTokens = 20000` remain unchanged.

The preview uses the selected model's context window, or the explicit override
bound to that same model. The settings response now projects that override.
Cached `model_context_window` alone is not authoritative. Unknown capacity stays
unknown. The bar is explicitly a capacity preview; it never claims to show
measured session usage.

The switch and slider edit a local draft. Save submits both fields. A failed
save leaves the draft retryable and displays the server error; only a successful
write and config reload reports Settings saved. Turning automatic compaction
off retains the threshold and describes the available manual command.

## Verification

Unit coverage exercises shared rounding/defaults, model-bound window overrides,
unknown capacity, explicit saves, failed-save retries, model search and OAuth
availability. Existing Settings routes, scope, keyboard navigation, legacy LLM
controls and canonical custom-provider tests remain covered.

`frontend/tests/visual/settings.spec.ts` uses the existing deterministic mock
server, all six viewport/theme projects and no real credentials. It checks
General, AI Models and Agent for horizontal overflow and serious/critical axe
violations, exercises search and save/reload, and writes review screenshots as
test artifacts. It does not replace existing screenshot baselines.

## Live Settings acceptance (2026-10-06)

Tested the production server and built frontend with Chromium at 1440×1000
and 375×812, using screenshots and coordinate mouse/keyboard input. No API
responses or model requests were mocked. An isolated home and workspace were
used; credentials were entered into a password field and excluded from Git.

Passed: builtin DeepSeek connection, model filtering and empty search, dark
theme and Chinese language persistence, all Settings tabs opening, model
selection in the composer, and a real `deepseek-flash` request through
`https://api.deepseek.com` returning `SETTINGS_OK` in approximately 1.6 seconds.
The Agent page showed 1,000,000 tokens and image input. Saving a 50% threshold
survived reload; saving 95% showed a 950,000-token trigger and 50,000-token
reserve. Automatic compaction could be disabled, saved, re-enabled and saved.
Mobile model cards, Agent preview and scrolling remained usable. No browser
JavaScript errors were recorded.

Two defects found by the live test were fixed: a missing NodeNext import shim
prevented the production server from starting, and normalization of Pi models
dropped maximum output and input-format metadata. Native Node import coverage
and builtin DeepSeek catalog assertions now guard those cases. Focused server
regressions passed (51 tests, 7 skipped), and workspace typechecking passed.
MCP external connectivity, SSH credentials, environment installation and
actual context compaction were outside this UI acceptance run.

## Review regressions

The ownership regression now verifies the transitional API explicitly: selecting
a model in session A changes both A and shared settings; session B initially
uses that shared choice; a subsequent model reload also updates loaded B. The
Agent UI describes these effects in English and Chinese rather than promising
independent defaults. Separating those writes and reload effects is future
ModelSelection work.

Provider regressions cover missing/invalid credentials, unsupported custom login,
disabled resources, canonical/legacy ID deduplication, credential and endpoint
repair, preservation of an existing credential, failed-save retry, enable/disable
and deletion. Custom resource mutations await Settings cache invalidation before
reloading, so repairs are visible before the 3-second cache TTL expires.

Verification after these review fixes: 47 frontend tests passed; 47 backend
business-route tests passed (7 skipped); 6 viewport/theme browser checks passed,
including overflow and serious/critical accessibility checks. Workspace typecheck,
frontend lint, production build and bundle budget passed. Screenshot-guided
coordinate input additionally exercised repair, disable, mobile enable and delete
against isolated provider fixtures; this run used no live provider credentials.

## Settings loading and large inventories

General renders from local preferences without calling `/api/settings/config`.
Only AI Models and Agent request that compatibility projection; pending requests
and errors do not block other tabs. Feature tabs load their own chunks and data
on demand. Progress hydrates through its existing lightweight appearance API.
Model-read errors offer an explicit retry, and obsolete scope reads cannot
overwrite a newer request.

Each config response reuses one fresh runtime/catalog snapshot for both model
capabilities and provider inventory. Credential state is not cached across
requests or mutations. Provider/model lookups use indexes instead of repeatedly
scanning the entire catalog.

Configured services use 20-card pages; each expanded provider uses 50-model
pages. Pagination bounds mounted content without introducing virtual scrolling.
Search uses a deferred, indexed query, resets pages, and preserves the user's
expansion choices rather than expanding every matching provider. All matching
models remain reachable through search and pagination.

Pointer hover or keyboard focus on Settings preloads the shell and General.
Other feature chunks stay lazy. The production SettingsContent chunk decreased
from approximately 149.6 kB to 13.4 kB before gzip; this is a shell reduction,
not a claim that the total code across all Settings tabs decreased by that amount.

Performance regressions cover a held model response, usable General/Progress
while it is pending, isolated errors and retry, and 100 providers with 10,000
models. Browser checks assert the 20-card/50-row pages, search beyond the first
page, cleared-search recovery and no horizontal overflow. Fixture timings are
diagnostic, not a production latency or frame-rate guarantee. Focused frontend
coverage passed 77 tests; backend business routes passed 47 tests (7 skipped).
All 12 browser checks passed across six viewport/theme projects, including the
large-inventory scenarios and existing accessibility/save/navigation checks.
Workspace typechecking, frontend lint, production build and bundle budget passed.
