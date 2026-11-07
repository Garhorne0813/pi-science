# Agent prompts and workspace instructions

Pi-Science assembles prompts through Agent Core rather than relying on the Pi
coding-agent CLI's discovery of SYSTEM.md or APPEND_SYSTEM.md.

## Ownership and composition

- `harness/SYSTEM.md` contains shared application rules. Version 2 defaults to
  directly completing the request, with validation scoped to the deliverable.
  Scientific file formats and multiple tool calls do not trigger research.
- `harness/roles/main.md` assigns coordination and final delivery to the main
  conversation. Delegates use the common core plus their assigned role body,
  not the main role. Delegation is optional; supply relevant project guidance,
  inputs, expected output and limits with each task.
- `prompts/runtime-context.ts` projects the committed lane model, reasoning level,
  active tool count and execution scope for every generation. Tool schemas already
  enumerate the available operations; do not duplicate large MCP lists. These are current
  configuration facts, not permission grants or secrets. Model identity does
  not depend on filtered Bash environment variables.
- The current enabled skill catalog is appended to interactive system prompts;
  detailed methods are loaded only when needed. Notebook operation guidance is
  included in the actual model-visible tool descriptions.
- Title and tool-free review Workers explicitly select isolated prompts. They
  receive no conversation core, project instructions, skills or Memory recall.
  Memory Extraction/Dream retain their independent tool-free prompts.

The Worker protocol distinguishes `prompt: { mode: "interactive", role? }` from
`prompt: { mode: "isolated", system }`. A role cannot replace the common core.
Application prompt text is loaded once when the Worker opens. Core version 2
appears in interactive runtime facts. Deploy/restart Workers to apply changes
to application rules; do not replace them midway through an active Worker.
Recovery after deployment uses the deployed version. Exact historical prompt
replay and automatic provider-dependent quality scoring are not implemented.

## User-owned AGENTS.md

Only the workspace-root `AGENTS.md` is automatically considered. It is optional:
users can create, edit, empty or delete it using ordinary workspace file tools.
There is no special project-document editor or endpoint. Workspace seeding,
Memory approval and background processes never create, restore or synchronize it.
The Agent edits it only when the user requests that work.

For interactive generations with an active `read` capability, the context hook
reads the current file as a labelled, lower-priority reference before the actual
conversation messages. A fresh present/empty/absent/unavailable snapshot supersedes
stale project guidance in summaries. These snapshots are not persisted into the
conversation transcript. Deletion stops future automatic injection; it does not
erase file text the user previously sent or explicitly requested through a tool.

The loader does not scan ancestors, follow symlinks, read multi-link files or
consume more than 64 KiB. Missing or unsafe/unreadable instructions do not block
the conversation. An unavailable snapshot is not a claim that the user refused
access. Workspace read protection still applies. Confined/candidate Workers never
load the root file; the parent supplies task-relevant guidance within the allowed
scope. Workspace delegates additionally require parent authorization for the read.
Read-disabled Workers do not receive the file.

Project instructions can specify background and conventions, but cannot override
application rules, current user requests, role limits or runtime permissions.
Other files, Memory, publications and tool output cannot promote themselves into
instructions. Memory review governs adoption for recall, not permission to answer
ordinary scientific questions.

## Migration and rollback

The packaged `harness/AGENTS.md` is replaced by `harness/SYSTEM.md`; it is unrelated
to the user-owned workspace file. No existing workspace file is moved or deleted.
`PROJECT.md` has no special role and is not automatically loaded, generated or
migrated. Existing files remain readable when the user references them. The old
GET/PUT `/api/project/document` routes return 404. Memory and archive routes are
unchanged. Reverting the application deployment restores its old prompt behavior;
there is no Memory or user-file migration to reverse. Worker and control-plane
versions must be deployed together because the initialization protocol changed.

## Verification

Automated tests exercise the real Harness generation path with a mocked provider:
live workspace-file changes/deletion, ephemeral context, capability/scope isolation,
parent authorization, background isolation, current identity after configuration
changes, common-core inheritance and model-visible notebook guidance. HTTP tests
check removal of project-document routes and preservation of existing files.

For a real-model comparison, use the same model, tools, inputs and budgets with
the old and new deployments; repeat cases where behavior varies. Include general
explanation, field inspection, legend movement, CSV export, grouped means,
statistical inference, literature synthesis, permission refusal, service failure,
malicious source text, notebook conflicts and model switching. Record completion,
tool calls, tokens, latency, unnecessary files/confirmations and evidence failures.
Simple tasks should avoid unrelated work; scientific and authorization cases must
retain their required checks. Mocked-provider tests do not establish these model
behavior improvements. Real-model results must be reported separately.

`harness/evals/cases.json` provides eight portable cases with synthetic input
files and review criteria. Run each case in a new disposable workspace/session;
keep the lifecycle case in one session and apply its file changes between turns.
Use an isolated application configuration with Memory, title generation and
unneeded connectors disabled to avoid recalling private user data or adding
unrelated background costs. Give execution cases the same working environment
and permissions in both deployments. Do not manufacture a pass when required
execution or rendering capabilities are unavailable. Record the raw measurements
listed in the fixture and review scientific correctness separately from resource
use. This fixture is an evaluation specification, not a claim of measured gains.
