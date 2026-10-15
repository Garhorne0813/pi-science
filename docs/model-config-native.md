# Pi-native model configuration (Pi 0.99.2)

This implements the versioned configuration and opt-in runtime path from the
2026-10-15 model configuration PRD v1.1. Both Pi dependencies remain pinned to
0.99.2; `pi-coding-agent` is not used. Session JSONL v4, ModelSelection v2,
ProductInput, Worker IPC event schemas and SSE v3 remain unchanged.

## Rollout

`PI_SCIENCE_MODEL_CONFIG_BACKEND` is read by the control plane:

| Value | Runtime | Management |
| --- | --- | --- |
| `legacy` (default) | Existing resource routes | Existing Settings; versioned API available for preparation |
| `shadow` | Existing resource routes | Explicit read-only comparison at `GET /api/model-config/shadow` |
| `pi_ai_v1` | Shared native registry plus explicitly retained legacy providers | Native AI Models Settings and versioned writes |

An invalid flag fails closed. The control plane sends the selected backend and
validated snapshot in the existing `settings` initialization payload; it does
not put the flag in the workspace environment. Each Worker keeps that revision
for its lifetime. Existing reload handling waits until a busy turn settles.
`reload_pending` means the disk commit succeeded but runtime publication needs a
retry; do not repeat the mutation with an old revision.

Defaults stay in `config.json`, and current selections stay in durable sessions.
Changing the default never broadcasts a replacement model to old conversations.
Removed/unavailable model IDs remain durable and require an explicit repair.

## Supported configuration

`$PI_SCIENCE_HOME/models.json` contains Pi-style `providers` plus Pi-Science's
revision/ownership manifest in the **same atomic file**. The HTTP editor exchanges
`{ revision, config: { providers: ... } }`, keeping manifest fields out of the
editable configuration. Example of the persisted file:

```json
{
  "schema_version": 1,
  "revision": 1,
  "providers": {
    "lab": {
      "name": "Lab",
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "models": [{ "id": "lab-model", "contextWindow": 32768, "maxTokens": 4096 }]
    }
  },
  "credential_refs": {},
  "keyless_providers": ["lab"],
  "legacy_providers": [],
  "aliases": {}
}
```

Accepted provider fields: `name`, `baseUrl`, `api`, non-authentication `headers`,
`models`, and `modelOverrides`. Model declarations and overrides accept `name`,
`reasoning`, `thinkingLevelMap`, `input` (`text`/`image`), `contextWindow`,
`maxTokens`, `cost`, and non-authentication `headers`; declarations also require
`id`. Supported custom APIs are `openai-completions`, `openai-responses`, and
`anthropic-messages`. Builtin models retain their official provider factory,
auth and stream implementations. Builtin API overrides must already be
supported by that provider. Unknown override IDs are rejected.

This is an explicitly limited 0.99.2 subset, not an implementation of the Coding
Agent's full models.json loader. Inline API keys, command expansion, arbitrary
auth headers, OAuth login, project overrides and 1.2-only fields are rejected.
Undeclared custom model metadata is displayed as Unknown. The runtime still
needs numerical limits and uses fallback defaults (128000 context / 16384
output) when these fields are absent; set verified limits before production use.

The file is written with mode 0600 under an advisory cross-process lock. Stale
revisions return 409; corrupt/symlink files fail closed rather than resetting to
an empty configuration. Configuration reads never perform inference, discovery,
or model capability self-heal writes. The older legacy backend retains its
existing initial resource import behavior; native mode skips that importer.

## Authentication and network boundaries

Settings shows Managed, Environment (variable name), Keyless or unconfigured
status independently of selectability and inference verification. Environment
values never enter configuration or browser DTOs. Exporting a vendor key alone
does not connect a native provider: an explicit reference is required. Reserved
application/internal, scientific connector and proxy variable names are rejected.
Changing the OS environment requires restarting the backend; reloading Workers
alone does not reread the OS environment.

The adapter implements Pi's CredentialStore with cross-process serialized writes.
Only API-key credentials are supported; OAuth is deliberately unavailable. Key
replacement uses a new credential and swaps its reference in the config commit.
Failure before commit removes the newly created credential. Unbinding does not
delete old credentials, so credentials shared with MCP remain intact. Retained
credentials are included in migration inventory; cleanup must audit all owners
before deleting anything.

The Worker environment allowlist and Job/MCP environment filters are unchanged.
Explicit model EnvRefs are projected from the trusted control-plane environment,
after workspace values, through the existing credential-name whitelist.
`PI_SCIENCE_INTERNAL_TOKEN` is never used as provider authentication.

Custom provider discovery uses the existing bounded fetch, DNS/private-network,
redirect and timeout checks. Inference injects URL validation into the official
stream implementation, preserving streamed response bodies and trusted proxy/CA
behavior. Custom inference rejects HTTP redirects rather than forwarding auth.
Both deployment and Settings private-provider controls must allow private URLs.
The deployment decision is pinned in trusted Worker startup settings, so its
absence from the Worker environment cannot relax the restriction.

## APIs

All existing control-plane authentication checks apply.

| Method and path | Behavior |
| --- | --- |
| `GET /api/model-config` | Validated snapshot, backend and redacted authentication metadata |
| `GET /api/model-config/catalog` | Shared registry catalog, revision, unknown metadata and selectability |
| `POST /api/model-config/preview` | Validate editable configuration without writing |
| `PUT /api/model-config` | Replace `{ revision, config }` atomically |
| `POST /api/model-config/providers` | Create `{ revision, id, config, credential? }`; optional managed/keyless credential is committed together |
| `GET /api/model-config/providers/:id` | Native provider snapshot; legacy mode returns an aggregated safe connection editor snapshot |
| `PATCH /api/model-config/providers/:id` | Replace `{ revision, config }` for one native provider |
| `DELETE /api/model-config/providers/:id` | Remove with `{ revision }`; retains credentials and session IDs |
| `PUT /api/model-config/providers/:id/credential` | `{ revision, credential: { source, ... } }`; managed/environment/keyless/remove |
| `POST /api/model-config/discover` | `{ base_url, api, secret? }`; explicit, rate-limited candidate discovery, no automatic commit or inference |
| `GET /api/model-config/migration` | Dry-run classification, source fingerprint and counts |
| `POST /api/model-config/migration` | Apply reviewed `{ revision, source_revision }` after backup |
| `GET /api/model-config/shadow` | Read-only available-ID and capability difference report |

`GET /api/provider-views` remains available with the compatibility DTO compiled
from the native registry when native mode is selected. Old entity write APIs
return `native_config_required` (409) in native mode; they cannot accidentally
change an obsolete authority. Legacy and shadow behavior remains compatible.
Settings connection editing no longer queries Endpoint and Binding separately.

## Migration and rollback procedure

1. Back up application data and use the default legacy backend to establish a
   production baseline. The old `config.json` to resource importer must already
   have run for configurations predating five-entity resources.
2. Read `/api/model-config/migration` and review every row and count. Read
   `/api/model-config/shadow`; explain all added/removed/changed IDs, limits,
   Thinking maps and input formats. These reads do not run model inference.
3. Apply the report with its revision and source fingerprint. A resource write
   lock protects conversion. A restricted backup directory under
   `model-config-backups/` preserves models, resources, credentials and settings.
   The old resource file is not rewritten or deleted.
4. Complex bindings, priority routes, aliases, allowlists, endpoint policies,
   shared/unsupported credentials, disabled records and unsupported capability
   metadata remain explicitly legacy. Such providers cannot be overwritten
   through the native editor. No route fields are silently flattened.
5. Test native mode in staging, including real providers, existing sessions,
   tools, Thinking, reconnect, trusted proxies/CA and credential rotation.
   Restart the control plane with `pi_ai_v1` only after the release gates pass.

Before native writes, rollback means restarting with `legacy`; snapshots and
session IDs remain intact. **After native writes, changing the flag alone is not
a data rollback.** Freeze writes, export the latest versioned snapshot and
credentials, reconcile changes against the preserved legacy backup, then switch.
No automatic reverse conversion is provided. Do not replace credential files
while sessions or MCP connectors are using them.

## Release gates still requiring deployment evidence

Automated tests cover revision contention, corruption/symlink rejection,
explicit-vs-ambient EnvRefs, reserved variables, shared MCP credential protection,
read-only snapshots, conservative migration/backup, route API redaction and
native-vs-legacy text/Thinking/tool stream equivalence using a local model mock.
Existing session, selection, Worker, event adapter and SSE tests remain in the
full regression suite. Frontend tests cover revision-conflict draft retention,
explicit discovery confirmation, environment status and restart copy.

This PR does **not** enable the backend by default, claim real-vendor inference
verification, remove legacy APIs/data (P5), provide universal OAuth, or perform a
production migration. Gate 2/3/4 deployment UAT and real-provider evidence remain
necessary before rollout. Legacy retirement requires zero remaining legacy
providers and an explicit shared-credential ownership audit.

## Reproducing validation

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm --filter frontend test:uat:model-config
pnpm smoke
```

The model-config UAT starts an isolated compiled control plane, uses Chromium,
and removes its temporary state. It verifies a keyless provider, explicit EnvRef
redaction and independent default selection without contacting a real model.
In a managed environment that supplies an HTTP proxy, Node's downloader may
require `NODE_USE_ENV_PROXY=1 pnpm smoke` for Micromamba provisioning; keep the
provided proxy and CA trust settings intact.

## Migration equivalence matrix

Automatic conversion is deliberately narrower than the legacy resource model.
Classification must finish in the dry-run; an unrepresentable row must never be
reported as migrated and then prevent unrelated healthy rows from being applied.
References are counted even when their binding or endpoint is disabled.

| Source topology or behavior | Automatic conversion | Preserved behavior / report reason |
| --- | --- | --- |
| One enabled custom provider, nonempty declared catalog, one supported endpoint and binding at priority 100 | Yes, if all remaining checks pass | Same provider/model IDs, destination, protocol, credential reference and supported capability/Thinking metadata |
| Custom provider with no discovered/declared models | No | `empty_model_catalog`; keep connection and allow healthy rows in the same apply |
| Two providers reference one endpoint | No | `shared_endpoint`; preserve shared connection ownership |
| Credential referenced by another provider-level map or another endpoint (including cross references) | No | `shared_or_unsupported_credential`; retain the graph, never clone credentials |
| MCP-owned, foreign-provider-owned, missing or unsupported credential | No | `shared_or_unsupported_credential`; keep original credential bytes and ownership |
| Required endpoint credential absent, even when a provider-level key exists | No | `missing_endpoint_credential`; a provider-level key must not activate an unavailable custom route |
| Explicit `protocol: native` endpoint, including an official provider behind a custom gateway | No | `native_endpoint_transport`; retain the exact legacy provider/stream dispatcher and destination until transport equivalence is proven |
| Multiple bindings, nondefault priority, aliases, header policies, allowlists, endpoint network/rate policies | No | Existing routing/policy reasons; retain IDs, routing and security behavior |
| Builtin credential with no Provider row and no shared reference | Yes, if authentication is supported | Keep official factory and the existing credential ID |
| Unsupported or unverified capability metadata, disabled resources, OAuth | No | Existing capability/disabled/authentication reasons; never silently drop metadata |

A successful apply preserves the legacy graph and credential files. A stale
source fingerprint or config revision rejects before committing; failure during
preflight leaves the active files and revision unchanged (a restricted backup
may already exist). Production migration still requires a frozen write window
and reconciliation of the report with actual deployment state.

## Header policy and validation timing

Provider headers, model headers and model overrides share one strict allowlist.
Header names are case-insensitive; duplicate names differing only in case and
CR/LF values are rejected. Accepted values have protocol-specific formats:

| Header | Accepted value |
| --- | --- |
| `Accept` | `application/json`, `text/event-stream`, or a comma-separated list of those types |
| `Content-Type` | `application/json` |
| `Anthropic-Version` | A date in `YYYY-MM-DD` form |
| `Anthropic-Beta` | Comma-separated feature names ending in `-YYYY-MM-DD` |

Free-form attribution, gateway and authentication headers are outside this
supported subset. Expanding the subset requires specifying and testing safe
value semantics; adding more words to a secret-name blacklist is insufficient.
Custom header authentication requires a separately reviewed CredentialStore
integration. Existing unsupported headers fail closed on read and need explicit
repair; rejected values are neither persisted nor echoed by the API. Protocol
headers listed above remain supported through configuration, disk, catalog and
stream construction.

Every commit validates the **entire** structural schema and provider/model
semantics. Network/DNS preflight validates only a provider's added or changed
explicit `baseUrl`, comparing against a deep copy of the previous configuration
under the same write lock. Creating a provider validates its URL even when
another provider uses that URL. Preview uses the same comparison without
writing. Credential rotation, renaming, removal and revision changes do not
re-resolve unrelated, unchanged destinations. At inference time the existing
DNS/private-network and redirect checks still apply to every custom request;
skipping redundant write-time DNS checks never authorizes a runtime request.

## Backend/API compatibility and negative tests

| Backend | Legacy model entity / Settings key and custom-provider GET | Legacy POST/PUT/DELETE | Versioned configuration authority |
| --- | --- | --- | --- |
| `legacy` (default) | Existing behavior | Existing behavior and status codes | Preparation only; runtime remains legacy |
| `shadow` | Existing behavior | Existing behavior and status codes | Dry-run/shadow reads have no persistent side effects; explicit preparation writes remain inactive |
| `pi_ai_v1` | Compatibility reads | 409 `native_config_required` for legacy model configuration endpoints, including credential validation and discovery/probe POSTs | Only versioned writes change native configuration; retained resources stay read-only |

The full App registers Settings first and model-config later in the same Fastify
scope. Fastify applies the scope's hooks at route finalization, so the existing
write guard also protects those earlier routes. The full-App regression checks
HTTP responses and every JSON file after Settings, provider, model, endpoint,
binding and credential writes. This registration-order concern did not require
a behavior change. Default/session model-selection APIs keep their existing
independent ownership and are not legacy entity writes.

Legacy authentication is projected from the resource graph and CredentialStore,
not from native credential mappings. Selected route references take precedence;
provider-level, bound and owned credentials remain visible for repair. Keyless,
managed and explicit EnvRef sources are redacted. An unresolved legacy provider
remains visible in Settings/catalog even when the Worker registry has no usable
route; its model is unavailable, not silently replaced.

| Negative scenario | Required result / regression in `model-config-review.test.ts` |
| --- | --- |
| Shared endpoint, provider/provider or provider/endpoint key reference | Both affected providers stay legacy; original files and ownership remain intact |
| MCP-owned credential | Keep legacy and leave MCP metadata/secret storage unchanged |
| Empty catalog mixed with a healthy provider | Explain empty row in plan; apply still migrates the healthy row |
| Native gateway endpoint | Retain provider object/stream dispatch, API and custom base URL |
| `X-ApiKey`, `X-Auth`, arbitrary custom authentication header at all three config levels | Schema/API reject; disk/revision unchanged; responses do not echo rejected values |
| Old persisted authentication header, invalid protocol value, CR/LF or duplicate header casing | Fail closed without repair writes or secret echo |
| Unchanged provider DNS offline during another provider's key rotation | Rotation/preview succeed without DNS; newly added/changed invalid destinations still reject |
| DNS changes to a private address after configuration | Runtime rejects before fetch when private providers are forbidden |
| Legacy managed/EnvRef/keyless/missing or expired credential | Settings, catalog and Worker agree on source/resolution/selectability; no secrets in DTOs |
| Stale or failed migration; dry-run/shadow reads | Active bytes, credential references and revision remain unchanged |
