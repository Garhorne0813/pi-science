# ProviderView: read-only model resource management

This phase adds a read model above the Settings redesign (#116) and model
selection ownership separation (#117). Canonical resources keep ownership of
providers, models, endpoints, bindings and credentials. The projection adds no
new configuration store and never writes model defaults or session selections.

`GET /api/provider-views?cwd=...` returns the shared `ProviderView` contract.
The optional workspace is validated by the existing workspace security boundary.
Resources and credentials remain global; only model selectability uses the
validated Core catalog for that scope. Core/catalog failures surface as request
errors rather than fabricated empty or disconnected inventory.

The response separates three facts:

- Credential configuration: managed/environment credential resolution through
  CredentialStore, builtin Core auth metadata, or explicit keyless authentication.
  Canonical credential/endpoint ownership keeps credentials configured when a
  binding is lost; missing routing cannot masquerade as a missing key.
  Configuration means credentials are present, not that inference succeeded.
- Selectability: membership in the same fresh Core catalog used by ModelSelection,
  combined with the canonical provider enabled flag. RuntimeModelResolver supplies
  saved model capabilities, valid routes and routing failure codes. A resolved
  native route unsupported by Core remains visible but unselectable.
- Inference verification: explicitly `never`, with no timestamp. This phase has
  no inference diagnostic implementation. Endpoint health, capability observation
  timestamps and successful `/models` discovery cannot promote this fact.

Builtin catalog resources and canonical resources are merged by provider and
model IDs. Input formats are copied from the same Core snapshot, and missing format metadata
is displayed as unknown rather than inferred from vision flags. Persisted model
entries take precedence; each provider/model appears
once. Unavailable providers and models keep their saved capability facts and
management actions. Catalog model counts describe registered inventory, including
builtin catalog models; they do not imply a network discovery or saved credential.

Routing issues contain stable backend codes. The frontend only translates those
codes and adapts presentation fields; it no longer derives availability using
`isConnected`, `has_key`, credential status or OAuth support. The server reports
allowed actions supported by the existing resource APIs. OAuth-only services
remain visible with unsupported-login guidance; this phase adds no login UI.
The payload contains no secrets, authorization headers, endpoint URLs, external
credential references or raw upstream error text.

AI Models queries this API independently of legacy Settings configuration.
All/Available/Needs attention filters use backend status. Existing paging,
deferred search and search indexing remain intact. Summaries show configured
credentials, catalog/selectable counts, repair reasons and unperformed inference
verification. Existing connection editors and explicit management writes remain
in use; discovery previews and model editors are separate later work.

Normal GETs never perform endpoint probes, discovery or inference, and do not
persist observations. The first access may execute the existing one-time legacy
resource migration, consistent with other canonical read routes. Native regressions
assert that subsequent reads leave persisted resources unchanged and never expose
synthetic test credentials.

## Migration sequence

1. This change: ProviderView contract, backend projection and AI Models reader.
2. Explicit bounded inference diagnostics through the actual Core execution chain,
   with timeout/token limits, a user-facing cost notice and separate persisted
   results. Ordinary GET must remain free of inference calls.
3. Resource revisions, partial updates and explicit secret replace/remove semantics.
   Concurrent editing and post-commit synchronization failures need their own
   write protocol; defaults and durable sessions keep separate ownership.
4. SettingsIntent navigation and advanced model editing, with discovered candidates
   reviewed and explicitly saved rather than replacing existing model inventory.

General configuration inheritance, plugin-defined pages, full ProviderView
pagination, diagnostics persistence and revision protection are not implemented
by this read-only projection. Snapshots are request-local; concurrent changes
between Core and resource reads are not atomic and require the later revision
contract. Legacy Settings configuration remains for Context Management and other
compatibility consumers, while AI Models and default selection have independent
read contracts.

The existing real 100-provider/10,000-model benchmark also measures this read API
against a 2,000 ms median budget. It checks selectable counts, absence of invented
inference verification, unchanged persisted files, concurrent health requests and
event-loop delay. Production-browser budgets still cover paged 10,000-model
inventory and default selection on desktop and mobile; test-only fixture adapters
never participate in the production read path.

## Lost connection repair

Editing a custom provider with no binding reuses its single owned endpoint and
recreates the binding through existing resource CRUD. The editor reads the same
ownership metadata to prefill the base URL. If the endpoint is also missing, an
explicit base URL rebuilds it with the compatible adapter and its unambiguous
owned credential. An empty key field preserves the credential. Multiple owned
endpoints or credentials require explicit resource repair rather than guessing.
The new binding does not restore deleted allowlists or aliases; those must be
configured again through binding CRUD.

Connect lists only builtin providers whose backend credential fact is
unconfigured; configured credentials remain maintained through their cards.
The inventory title, including fallback text, is Model services / 模型服务.

## Validation

On 2026-10-08, contracts (15), the full server suite (858 passed, 15 skipped),
full frontend suite (1,271) and skills (28) passed. After the final input-format
and owned-credential projection adjustments, all 14 native selection/management
regressions passed again. Typecheck, package builds, frontend lint, visual
TypeScript checks and bundle budgets passed.

Eight production-browser checks passed on desktop light and 375 px mobile,
including Settings accessibility, default/session isolation, context-load failure
isolation and 10,000-model inventories. Inventory ready/search timings were
368/378 ms on desktop and 303/380 ms on mobile, with no recorded Long Tasks above
50 ms during that inventory interaction. Browser fixtures isolate frontend work
from real network/backend latency; these results do not claim live-provider
inference or slower-device performance.

The final real backend benchmark passed all committed budgets: catalog median
108 ms, Settings median 1,097 ms, ProviderView median 1,160 ms, maximum event-loop
delay 237 ms and concurrent health p95 136 ms. Configuration, model resources and
credentials kept identical content and modification timestamps after repeated
reads. These measurements describe the local Linux environment.

The lost-binding follow-up passed 44 focused server tests (including real Core
catalog restoration and byte-identical credential persistence), 18 AI Models
component tests and four desktop/mobile production-browser checks. Browser
repair uses HTTP fixtures; the server integration test separately exercises the
real writer and Core projection. Workspace typecheck/build, frontend lint and
visual TypeScript checks passed for this follow-up.
