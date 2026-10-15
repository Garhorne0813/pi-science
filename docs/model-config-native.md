# Native model configuration

The governing requirements are [PRD v2: 完全替换](prd-model-config-v2-replacement.md).
This replaces the v1.1 staged legacy/shadow rollout. The sole backend is
`pi_ai_v1`, enabled by default. Setting `PI_SCIENCE_MODEL_CONFIG_BACKEND` to
`legacy`, `shadow`, or an unknown value fails validation. There is no runtime
legacy adapter, automatic import, or fallback after errors.

## Authority and storage

`ModelConfigService` reads models.json, `ModelCredentialAdapter` resolves explicit
CredentialStore mappings, and `ModelRegistryService` constructs Pi 0.99.2 providers.
Settings, provider-views, selection catalogs and Workers use this native authority.
An absent file means empty configuration; builtins remain discoverable but ambient
API keys and old resource references are never adopted. Reads never create files.
Invalid files fail closed. A nonempty `legacy_providers` list is rejected and must
be explicitly reconfigured; the empty field remains in schema version 1 only as
a format constraint, not a functional compatibility mode.

Example models.json (credentials contain only opaque IDs, never secrets):

```json
{
  "schema_version": 1,
  "revision": 1,
  "providers": {
    "lab": {
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "models": [{ "id": "lab-model", "contextWindow": 32768 }]
    }
  },
  "credential_refs": {},
  "keyless_providers": ["lab"],
  "legacy_providers": [],
  "aliases": {}
}
```

Supported custom APIs: openai-completions, openai-responses, anthropic-messages.
Builtin providers retain official factories/stream implementations. Model metadata
and thinking maps are explicit; unknown capability metadata is shown as unknown.
Models are selectable only with resolved authentication; selectability does not
prove real inference. No universal OAuth or inline keys, ambient file/env auth,
shell command expansion or newer Pi configuration fields are supported.

All writes validate the complete structural schema and provider/model semantics.
Revision checks, a cross-process configuration lock, mode 0600 on POSIX and atomic
replacement protect commits. Credential replacement uses a new resource ID and
cleans it up after failed commits; it never deletes shared historical credentials.
Deleting a provider removes its native mapping, not CredentialStore records or
persisted session model IDs. Busy Workers reload after their current turn.

## API and retired entry points

| Endpoint | Behavior |
| --- | --- |
| GET /api/model-config | Validated snapshot and redacted authentication |
| GET /api/model-config/catalog | Native catalog, availability and revision |
| POST /api/model-config/preview | Read-only full validation |
| PUT /api/model-config | Atomic `{revision, config}` replacement |
| POST /api/model-config/providers | `{revision, id, config, credential?}` creation |
| GET/PATCH/DELETE /api/model-config/providers/:id | Read/update/remove native configuration |
| PUT /api/model-config/providers/:id/credential | Explicit managed/environment/keyless/remove |
| POST /api/model-config/discover | Rate-limited candidate discovery; no save or inference claim |
| GET/POST /api/model-config/migration | Optional reviewed import of old resource graph |

Old `/api/providers`, `/api/models`, `/api/endpoints`, `/api/credentials`,
`/api/provider-endpoint-bindings`, `/api/custom-providers`, Settings api-key/custom-
provider routes and `/api/model-config/shadow` return **410 model_config_retired**
for all methods, including descendant/query/trailing-slash forms. CRUD handlers
and the old Settings editor are removed. Tombstones perform no discovery or writes.
MCP connector credential APIs are independent and remain available.

Existing `/api/provider-views`, `/api/settings/providers`, `/api/settings/config`
and model-selection DTOs remain for the current application, sourced only from
native configuration. Settings returns no old custom-provider entries. Default
selection and each session's selection remain independent; an unavailable saved
default is reported, never silently substituted or cleared. Live session capability
projection remains read-only and may observe its pinned revision until reload.

## Optional import, never runtime compatibility

GET migration classifies the old resource graph without changing files or secrets.
It does not run at startup or automatically convert inline legacy Settings keys;
older Settings-only installations can configure providers directly in the new UI.

| Source | Result |
| --- | --- |
| Simple enabled provider, nonempty catalog, supported transport, one binding at priority 100 | migrated if all checks pass |
| Existing native ID | existing; never overwritten |
| Empty custom catalog | blocked / empty_model_catalog |
| Endpoint bound to more than one provider | blocked / shared_endpoint |
| Cross-provider or MCP-owned/shared/unsupported credential | blocked / shared_or_unsupported_credential |
| Explicit native endpoint/gateway | blocked / native_endpoint_transport; transport equivalence unproven |
| Builtin Provider with a non-native resource endpoint | blocked / builtin_endpoint_transport; native overrides would expand its routed catalog or change dispatch |
| Multiple/disabled bindings, priority/alias/header/allowlist/policy routing, OAuth or unsupported capabilities | blocked with reasons |
| Builtin credential without Provider row | migrated only if owned/supported/unshared; otherwise blocked |

POST requires `{revision, source_revision, excluded_provider_ids}`. With blocked
rows, no apply occurs unless the excluded ID set exactly matches the report.
Excluded providers do not run; manually rebuild them in the new system. Healthy
rows can then import without an empty catalog blocking the transaction. Only
aliases targeting present native models import. The source fingerprint and native
revision must still match. A backup of models.json, model-resources.json,
credentials.json and config.json is created before committing. Sources and
Credential ownership remain unchanged. Failed preflight preserves active bytes
and revision; a backup may already exist.

## Headers, EnvRef and network security

Headers share a strict name **and value** allowlist across Provider/Model/Override:

| Header (case insensitive) | Allowed value |
| --- | --- |
| Accept | application/json, text/event-stream, or comma-separated list |
| Content-Type | application/json |
| Anthropic-Version | YYYY-MM-DD |
| Anthropic-Beta | Comma-separated feature names ending in -YYYY-MM-DD |

Other headers, CR/LF, duplicate case variants and arbitrary authentication values
are rejected on write and persisted-file read. Custom auth headers require a
separate reviewed CredentialStore integration. Rejected secret values are never
echoed. EnvRef must explicitly name a permitted variable; internal, research,
network proxy and system names remain reserved. Worker environment allowlists
and trusted proxy/CA handling are unchanged.

Write/preview network preflight resolves only added or changed explicit URLs,
comparing with a deep copy under the write lock. Credential-only/revision/unrelated
writes do not re-resolve offline providers. Every custom runtime request still
checks DNS/private-network policy and forbids redirects, including DNS rebinding.

## Verification and release

Replacement regressions cover old shared builtin refs without Provider entities,
old inline/custom settings, no-read/no-write fallback, removed switches, blocked
manifests, tombstone methods, explicit exclusions, alias filtering and preserved
MCP ownership. Native auth regressions exercise managed, EnvRef, keyless and lost
credentials through Settings/catalog/real Workers. Existing revision, atomic-write,
stream, SSRF, session/default, cancellation and durable recovery tests remain.

Run pnpm test, pnpm typecheck, pnpm build, frontend test:bundle,
frontend test:uat:model-config and pnpm smoke. In managed proxy environments,
Micromamba provisioning may require NODE_USE_ENV_PROXY=1 pnpm smoke.

Deploying this version changes the default: **old model configuration stops being
used immediately**. Prepare native configuration or perform an explicit import
before production deployment; unresolved blocked rows require reconfiguration.
Real vendor inference, proxy/CA and production data rehearsal remain release gates.
No production import or PR merge is performed automatically. Rollback is deployment
of the previous version with reviewed backups, not a legacy switch in this version.
