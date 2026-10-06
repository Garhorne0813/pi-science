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
| Agent capabilities | Skills, Extensions, MCP | Preserve the existing skill, subagent, web access and managed connector controls |
| Scientific compute | Environments, Compute | Environment revisions and scientific execution resources |

The desktop sidebar identifies the workspace path or global scope. The content
explains that model credentials and agent defaults are shared; workspace skill,
MCP and compute resources use the workspace captured when Settings opened.
Changing scope remounts the content so drafts cannot cross workspaces.

General has three theme choices plus language and panel-order preferences.
AI Models retains canonical model-resource mutations, API key connection,
custom service discovery, credential replacement and disconnection. Connected
service cards are searchable by service/model name and ID; mobile model rows
wrap and retain context/output labels. Model rows expose only the supported
thinking levels received from the catalog. OAuth-only services show Login
required and explain that subscription login is unavailable here.

Agent shows the configured model and its supported capabilities, with a link
to model connections. Conversation-specific model and thinking selectors stay
in the composer. A missing model stays unavailable; Settings does not replace it
or infer capacity from a cached value for another model.

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
