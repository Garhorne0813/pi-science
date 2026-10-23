# AI Models connection UI

This change builds on PR #155 (`2df0ebd`) and retains the Agent Core Worker architecture merged in PR #115. Native Model Config remains the only configuration authority. Retired model-resource writes remain HTTP 410.

## Implemented release scope

The API and subscription flows both use native configuration. Subscription entries come from the installed pi-ai 0.99.2 providers whose public OAuth adapters declare `isSubscription`. The server bridges their real PKCE/browser, manual callback and device-code interactions. Production never substitutes simulated login responses. Account/plan data remains unknown when the SDK does not provide it. Live account acceptance remains separate from protocol tests with provider HTTP fixtures.

- The home view filters the native catalog by `configured`, independently of credential resolution or model availability. Explicit provider configuration, credential references (including missing credentials) and keyless declarations count as configured. Untouched runtime registry entries are connection candidates only.
- Provider rows start collapsed and expand independently. Search matches configured provider names/IDs and model names/IDs. Service and model pagination bounds the rendered list.
- Existing credentials are managed only through each provider's accessible menu. Connection details, custom connection editing, candidate refresh and disconnect use the same menu and backend capability declarations. No legacy enable/disable operation is exposed.
- The connection dialog reuses the existing Modal, with a 600×620 frame bounded by viewport minus 32px. Tabs and footer stay outside the internally scrolling body. API and Subscription have separate contents. Custom API remains above provider search results.
- Builtin API credentials use the native credential PUT. Custom API supports the three native protocols, managed keys, environment references and explicit keyless authentication. Creation validates before atomically saving provider and credential metadata. New connections receive a stable `custom-<UUID>` provider ID automatically; the form only asks for a display name. Once a valid HTTP(S) base URL and the chosen credential source are complete, model discovery runs after an 800 ms typing pause. Changing URL, protocol or credentials clears selection, aborts the old request and ignores late responses. Discovery never locks the form or saves/enables candidates. Users explicitly select models, retry discovery or enter manual model IDs. Discovered display names are retained; unspecified context/reasoning capabilities remain unknown.
- Custom editing preserves unedited provider fields and metadata on retained models. Removed model overrides are removed with the model. Candidate refresh uses the current stored configuration and server-held credential, returns no credential, and does not write configuration or claim verified inference.
- All writes capture an opening revision. HTTP 409 refreshes the server projection, retains the draft, and never automatically replays a secret-bearing write. Reopen the dialog to work from the new revision. Secrets are cleared on successful save or confirmed discard and are not persisted in browser storage.
- Unsaved changes require explicit discard when closing or switching connection steps. Nested modal keyboard events do not close the outer Settings dialog. Credential dialogs restore focus to the provider menu trigger.

## API additions

`ProviderConfigView.configured` expresses explicit configuration, rather than resolved authentication. The catalog includes `source`, `auth_capabilities` and `allowed_actions`; capabilities come from the compiled runtime provider and the server's implemented adapters. The compatibility provider view also includes the explicit configured flag.

`POST /api/model-config/providers` additionally accepts `{ source: "environment", environment_variable }` as its optional credential. It uses the same reserved-variable rules, copy-on-write storage and rollback behavior as credential replacement.

`POST /api/model-config/providers/:id/discover` accepts an empty object and discovers candidates for an existing authenticated custom connection. It uses the existing outbound request policy and discovery rate limit, resolves credentials on the server and returns `{ models, inference_verified: false }`. It makes no configuration writes. `POST /api/model-config/discover` also accepts an optional `environment_variable` instead of `secret` for draft connections. The server resolves the reference using the same reserved-variable rules as persistence; missing/reserved references and ambiguous credentials are rejected before outbound requests. Keys and resolved values are never returned. Both discovery routes retain outbound URL policy and rate limiting and send `Cache-Control: no-store`.

Disconnect uses native provider DELETE with revision protection. It removes native configuration and its credential mapping/keyless declaration. Shared credential objects, legacy resources, historical sessions and model IDs remain governed by the existing native semantics.

## Validation

Unit/integration coverage checks explicit vs untouched providers, broken credentials, server-reported capabilities, environment creation consumed by Worker registries, reserved-variable rejection, revision-protected disconnect, stored-credential discovery without persistence, menu-only management, draft isolation, conflict preservation, metadata-preserving editing and nested Escape behavior.

`pnpm --filter frontend test:uat:model-config` runs against the built real server and Chromium. It checks native authority, atomic Keyless creation, EnvRef redaction, default-model ownership, desktop frame invariance across tabs/forms, responsive bounds, footer containment, keyboard tabs/focus/discard and modal accessibility in light/dark/mobile. Set `MODEL_UAT_SCREENSHOTS` to an absolute directory to retain screenshots.

The visual Settings performance fixture uses the new native catalog fields and menu controls, preserving the 100-provider/10,000-model regression case. Standard typechecks, production build, lint, bundle budget and backend/frontend suites remain applicable.

## Recorded acceptance — 2026-10-20

- Full package suites: Contracts 15 passed; Server 942 passed / 8 skipped; Frontend 1,755 passed; Skills 28 passed (2,740 passed in total).
- Workspace typecheck, production build, frontend lint, visual-suite typecheck and bundle budget passed. The build retains the existing large-chunk advisory; initial JS gzip is 344,017 bytes.
- Real-server Chromium model-config UAT passed, including modal accessibility scans and light/dark/mobile geometry/focus checks. The two desktop/mobile Settings performance cases passed with 100 providers and 10,000 models.
- The unmodified general smoke reached job environment provisioning and returned HTTP 400 while setting up its fresh Conda environment. A scratch copy of the same smoke, with a pre-created local Python venv in its temporary workspace, passed end to end. No runtime/environment implementation was changed to accommodate this test.
- This initial API-stage acceptance preceded the subscription implementation described below. It did not exercise real subscription authorization or paid-provider inference.


## Subscription OAuth on Pi 0.99.2

Both Pi dependencies remain pinned to 0.99.2. The server calls the installed provider's public `auth.oauth.login` and bridges its typed `AuthInteraction` notifications/prompts to authenticated, non-cacheable HTTP endpoints. The SDK owns PKCE/state validation, official token exchanges, callback-server cleanup, device-code polling and refresh protocol. There is no second provider-name list in the frontend.

- Start: `POST /api/model-config/oauth/:provider/start` with the opening revision and explicit `replace_existing` confirmation when replacing an API/keyless credential. There is one active authentication mapping per provider. A successful grant is committed only if the captured native revision still matches. Failure, cancellation, timeout and conflict preserve existing authentication.
- Interaction: `GET /api/model-config/oauth/:provider/current` restores the current server-side session; `GET /api/model-config/oauth/sessions/:id` reads its state; `POST .../sessions/:id/respond` submits a one-use prompt ID/value; `DELETE .../sessions/:id` cancels it. Sessions expire after ten minutes, are bounded, and are isolated to the current authenticated server/configuration owner. They are cancelled on server shutdown. Transient PKCE events/codes are dropped after settlement; token-bearing exceptions are never returned.
- Persistence: grants are dedicated OAuth CredentialStore records, not inline models.json data. Provider-specific refresh metadata is retained. A stable local installation UUID satisfies ChatGPT's device-ID requirement. Public DTOs show status/expiry with unknown account/plan, never tokens. The browser persists no authorization codes, API keys or OAuth tokens.
- Runtime: Worker registries still pin their native configuration revision. They may renew the existing OAuth grant bound to that revision under a per-grant, cross-process lock. The latest token is re-read under that lock; refresh rotates that dedicated credential only, without changing native configuration revision. Publication checks the current provider mapping again under the config lock. Logout/reauthorization prevents old Workers from writing a late refresh, resurrecting a grant or adopting a different account. Refresh failures preserve existing credentials and never fall back to an API key.
- Endpoint safety: a subscription grant may only use its native provider endpoint. This is checked at authorization, on later configuration changes, and when compiling a Worker snapshot, including tampered configuration files.
- Management: the provider menu opens subscription status, reauthorization, refresh and confirmed local disconnect, with no API-only fields. `POST /api/model-config/oauth/:provider/refresh` requests SDK refresh; `DELETE /api/model-config/oauth/:provider` removes the current local binding with revision protection. As in the existing native credential semantics, historical stored records/backups are preserved and cannot be consumed after unlinking. Pi 0.99.2 exposes no generic provider-side revocation operation: the UI explicitly directs users to provider account settings to revoke that grant remotely.

`pnpm --filter frontend test:uat:model-oauth` uses the real built app, Chromium and the installed Copilot SDK, with external provider HTTP responses supplied by explicit test fixtures. It checks cancellation, denial, pending-session restoration after browser reload, successful persistence, Worker consumption, token redaction, refresh, local disconnect, fixed dialog bounds and accessibility. Backend tests additionally execute the installed ChatGPT PKCE flow (including state mismatch), verify automatic token rotation and use separate Node processes to verify single refresh across processes. These checks establish implementation behavior; they do not claim a login to a real user's subscription or a paid-provider inference run.

## Subscription implementation acceptance — 2026-10-20

- Versions unchanged: pi-ai 0.99.2 and pi-agent-core 0.99.2; no dependency lockfile changes.
- Full package suites: Server 957 passed / 8 existing skips; Frontend 1,761 passed; Contracts 15 passed; Skills 28 passed. Total: 2,761 passed, 8 skipped. After final hardening, all 88 model-configuration tests passed; the 11 OAuth protocol/lifecycle tests were also rerun after making the child-process fixture environment portable.
- Workspace typecheck, production build, frontend lint, visual-suite typecheck and bundle budget passed. The existing large-chunk advisory remains; initial JS gzip is 344,015 bytes.
- Both real-server Chromium suites passed: API model configuration (including desktop/dark/mobile geometry and accessibility) and subscription OAuth (SDK provider HTTP fixtures, cancellation, denial, reload restoration, Worker consumption, token redaction, refresh, local disconnect and accessibility).
- Safety regressions include PKCE state rejection, cancelled/expired flows, revision conflicts, simultaneous Worker/process renewals, failed refresh preservation, logout/reauthorization races, cross-provider grant rejection, immutable OAuth endpoints and a credential ownership change during an in-flight renewal.
- These are implementation and protocol acceptance results. No real user subscription account was logged in, no paid-provider inference was exercised, and no generic remote grant revocation is claimed. Production code calls the installed providers' real OAuth adapters; only test scripts supply HTTP fixtures.

## Automatic custom model discovery acceptance — 2026-10-20

- Provider IDs are generated once per new draft and remain stable after saving/renaming. Users supply the display name, URL, protocol and credentials, then select discovered models or enter manual IDs.
- Automatic discovery is debounced by 800 ms. Tests cover incomplete input, typing bursts, cancelled requests, stale responses, explicit retry, environment references, keyless requests and cancellation on dismissal. Failures offer manual configuration without echoing upstream error payloads.
- All 89 model-configuration tests passed. The affected connection/resource suites passed all 47 tests after preserving provider-supplied model display names. The frontend model/settings suites passed all 48 tests.
- Workspace typecheck, production build, frontend lint and bundle budget passed. After the final display-name change, the server build and affected resource/connection tests passed again. Initial JS gzip is 344,008 bytes; the existing large-chunk advisory remains.
- The real-server Chromium model-config UAT passed with a local HTTP provider fixture: entering URL/key automatically fetches `/v1/models` through the server, candidates remain unselected/unpersisted, switching to keyless triggers discovery without an Authorization header, and selected model names plus generated provider IDs survive saving. Existing credential, default-selection, focus/discard, light/dark/mobile and accessibility checks also passed. This does not claim inference verification or metadata that the provider did not supply.
