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

## Shared connection edits

Custom-provider edits preflight all affected resources before changing a name,
endpoint, or credential. If another provider binding references the endpoint,
changes to its address, API format, key, or credential reference return HTTP 409
`resource_in_use`. Disabled bindings still count. Name-only edits and identical
normalized addresses remain valid without rewriting the endpoint.

Key replacement also rejects credentials referenced by another endpoint
(including a disabled endpoint) or an entry in the builtin credential-reference
map. Missing-connection repair performs this check before creating its endpoint.
Rejected edits leave resources, credentials, defaults, routing, and runtime
reload untouched. No copy-on-write or cross-resource transaction is introduced;
concurrent reference changes still need the later revision/write protocol.

Switching a private endpoint to no authentication detaches only its own reference.
A key still used by another endpoint or builtin provider is preserved. Shared
endpoints cannot be detached through an individual provider editor.

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
Configured builtin cards continue to expose replacement whenever the backend
allows `replace_credential`; Connect's credential filter never governs this
maintenance action. Creation and endpoint reconstruction share a hostname-based
loopback classifier (`localhost`, IPv4 127/8 and IPv6 ::1) for default data egress.
When an existing endpoint address changes, its default egress classification is
recomputed using the same rule. A direct Endpoint API update can explicitly supply
`data_egress`; unchanged normalized addresses retain their current classification.
Custom-provider edits do not supply an explicit override. This classification is
metadata and does not replace outbound URL validation or network policy.

Repair remains a sequence of resource writes, not an atomic transaction. If the
final binding creation fails, HTTP 500 carries `connection_repair_incomplete`,
`partial_commit: true` and `failed_step: "create_binding"`. Its user-facing message
states that connection changes were saved and asks the user to review/retry.
Provider/endpoint and explicit credential changes may already be persisted; the
writer does not imply rollback. The editor retains its draft and displays that
message. Retrying reuses the owned endpoint and credential rather than duplicating
them. General atomic writes and revision conflicts remain a later phase.


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

The third review follow-up passed 50 focused server tests, 20 AI Models component
tests and six desktop/mobile browser checks. Fault injection covers final binding
failure with both an existing and deleted endpoint, explicit persisted credential
replacement, partial-commit HTTP metadata and a retry that preserves credential
bytes without creating duplicate endpoints. Loopback reconstruction keeps local
egress. The browser verifies configured builtin key replacement and Connect
exclusion. Workspace typecheck/build, lint and visual TypeScript checks passed.

Review comment follow-up: `remove_credential` requires an existing managed
credential reference, independently from credential configuration/selectability.
Environment-only and external credentials remain configured/selectable when Core
reports them available, but their cards expose no Disconnect action. Direct
legacy deletion attempts return `credential_not_removable` without altering
resources, credentials or the global default.

Management projections share a request-local credential snapshot across builtin
model facts, canonical routes and status/actions. Snapshot reads parse the file
once; defensive copies prevent mutation, and each new projection reads fresh
state. Core construction shares a synchronous snapshot for canonical routes and
keeps builtin authentication callbacks live. There is no cross-request secret
cache or new credential owner. `scripts/benchmark-provider-credentials.mjs` keeps
100 providers/10,000 models fixed while increasing stored credentials through
1/100/1,000, with a 2,000 ms median budget and unchanged-file assertions.
Linux CI enforces this budget and uploads the credential-growth measurements.

The integrated comment fixes passed 15 contract tests, 874 server tests (15
skipped), 1,285 frontend tests and 28 skills tests, plus typecheck, builds, lint,
visual TypeScript checks and bundle budgets. Fourteen production-browser checks
passed across desktop and mobile, including inventory/default/Composer budgets
and builtin credential maintenance. The local credential-growth medians were
489/463/499 ms for 1/100/1,000 credentials. The independent 10,000-model backend
benchmark also passed: catalog 131 ms, Settings 1,357 ms, ProviderView 1,216 ms,
event-loop delay 255 ms and concurrent health p95 186 ms. Both benchmarks verified
unchanged persisted files; browser fixtures do not exercise live inference.


Endpoint maintenance keeps enablement explicit. Editing/saving connection fields
preserves a disabled endpoint; its detail editor exposes Enable endpoint using
the existing endpoint API. Enabling retains unsaved editor fields and credentials,
and refreshes endpoint/provider facts. Failed enablement retains the editor for
retry. Real Core integration verifies the disabled route becomes selectable.

Builtin credential removal also checks endpoint references before any writes or
runtime reload, returning `resource_in_use` for a shared managed credential.
ProviderView withholds Disconnect while referenced; replacing the key remains
available. Removing the endpoint reference makes normal managed removal available
again. Revision-based protection against concurrent reference changes remains
part of the later write-protocol phase.

The card menu labels each destructive action by the mutation it performs. A
custom provider shows Delete provider, confirmed with the provider-deletion copy,
and sends `DELETE /api/custom-providers/:id`; Disconnect stays reserved for
builtin credentials whose ProviderView reports `remove_credential`, so a card
never offers credential-style wording for a provider deletion. The AI Models
model count uses pluralized copy.

The maintenance-boundary regressions passed 62 focused resource/selection server
tests and 52 frontend tests (including inherited Composer reference regressions),
plus 16 production-browser checks on desktop/mobile. Workspace typecheck/build,
lint, visual typecheck and bundle budgets passed. The real credential-growth
benchmark passed again at 428/442/454 ms for 1/100/1,000 credentials and retained
unchanged persisted files. These are scoped follow-up results, not a rerun of the
previously recorded full-stack suite.
