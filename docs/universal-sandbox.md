# Universal process sandbox

Role policies, macOS execution, controlled outbound networking, confined local
MCP/Jobs and environment installation are described in [Sandbox profiles](sandbox-profiles.md).

## Live DeepSeek smoke test

`apps/server/src/runtime/agent/deepseek-sandbox.live.test.ts` calls the official DeepSeek API with `deepseek-flash`, enabled thinking and `reasoning_effort: high` through the product's provider routing and real Agent Workers. A local audit gateway verifies the unchanged request body before forwarding it exclusively to `https://api.deepseek.com/v1/chat/completions`; it records request settings, response status and token usage without recording credentials or reasoning text. It verifies main/authorized-child Bash execution, protected-file and credential isolation, execution policy evidence and captured artifacts. It does not replace the separate Python Notebook acceptance tests. The live test is skipped by default and incurs provider usage when enabled.

Supply `DEEPSEEK_API_KEY` through the process environment, allow outbound HTTPS to `api.deepseek.com`, and configure the Linux or macOS sandbox dependencies described below. The test explicitly forwards that environment-backed credential to the Worker; Workers intentionally do not inherit ambient provider secrets, and sandboxed tools never receive it. The credential store saves only the environment-variable reference; temporary test settings and transcripts are deleted on completion. A credential-free audit report remains under `.runtime/live-tests/deepseek-flash-high-*.json`. The test allows at most eight model requests; skipped or rejected calls are not API success. Run from the repository root:

```bash
PI_SCIENCE_DEEPSEEK_LIVE_TEST=1 pnpm --filter @pi-science/server exec vitest run src/runtime/agent/deepseek-sandbox.live.test.ts
```

A proxy `CONNECT` 403 means the request has not reached DeepSeek and cannot establish whether the API key or model is valid. A skipped live test is not evidence of API success.

Based on PR #157 (`e2634fb89fe10f355224941d42adddfe1ae8e093`), Bash and Python Notebook now use the pinned `@anthropic-ai/sandbox-runtime@0.0.79` execution layer independently of Skills. Bash retains its name, schema, upstream output capture/checkpoints and budget wrapper. Python kernels retain the JSONL bridge, rich outputs, streaming and shared variables between cells. HTTP `execute` and `execute-stream` enforce the same server policy as agent tools.

## Operator configuration

`PI_SCIENCE_EXECUTION_MODE` defaults to `required`. Sandbox setup failures refuse execution; there is no host fallback. Linux x64/arm64 requires Bubblewrap, socat, ripgrep and the packaged Unix socket seccomp filter. macOS x64/arm64 requires Seatbelt (`sandbox-exec`), clang and the native descendant supervisor. Windows fails closed in required mode. R Notebook kernels are blocked in required mode pending separate bridge acceptance.

Set optional absolute binary paths with `PI_SCIENCE_SANDBOX_SOCAT` and `PI_SCIENCE_SANDBOX_RIPGREP`. Optional `PI_SCIENCE_SANDBOX_RUNTIME_PATHS` is a JSON array of narrow, administrator-approved read-only dependency paths for Bash. `PI_SCIENCE_SANDBOX_PYTHON_ROOT` also grants its trusted preinstalled environment to Bash. A server-selected workspace environment prefix takes precedence on PATH, stays read only and contributes its revision ID to execution evidence. Broad system/home roots and dependencies overlapping writable workspace paths are refused. Ordinary analysis cannot mutate approved runtime environments; the environment service provisions new revisions through the separate `install` profile. Python Notebook uses the environment revision selected by the server; its prefix must be outside writable workspace paths. The server installation, launcher, Node/srt runtime and bridge must likewise be outside writable workspace paths; overlap fails closed so code cannot rewrite a future trusted launcher. Aliases resolving to broad dependency roots are refused too.

An optional private `PI_SCIENCE_SANDBOX_READ_POLICY` file can bound dependency grants and protect service-owned data. Its format is `{ "schemaVersion": 1, "dependencyRoots": ["/srv/pi-runtime"], "protectedRoots": ["/srv/private-data"] }`. All listed paths must exist; the file must be operator-owned, single-link and mode 0600 outside writable workspaces. Protected roots cannot overlap effective runtime reads/writes. The Worker receives the path only from server launch configuration. Ordinary Auto Research needs no such file. Stop active workloads before changing roots; subsequent Notebook cells retire stale namespaces, and changed admission digests fail before startup.

An administrator can explicitly set `PI_SCIENCE_EXECUTION_MODE=trusted-host` for trusted workspace operations. This is service configuration, never a tool argument, prompt, workspace setting or request-body option. Candidate Bash/Notebook always require isolation even when ordinary workspace execution is authorized on the host.

## Authorization and process lifecycle

Tool permissions and filesystem policy are separate. Main and child permissions continue through AgentHarness, parent intersection and per-call delegated capability rechecks. Agent front matter can declare `execution_scope: confined` (generic grants) or legacy `execution_scope: candidate` (project/builtin default: `workspace`; Skill-local default: `candidate` when omitted). This is a restriction, never an added capability: dispatch inherits the Parent's eligible active tools when a role omits `tools`, or intersects an explicit role list with the Parent; task-level `tools` can only narrow that set. `tools: []` grants no tools. Confined scope additionally applies the Candidate ceiling (read, Bash, Notebook read/run). Any assigned `candidate_id` also forces that ceiling regardless of the role name. The authenticated server binds `executionScope` in Worker startup and signed Notebook grants; model tool parameters cannot set it. Unbound Candidate workers can only generate text; reads/execution fail closed. Candidate binding and scope are inherited by nested children and cannot be widened by choosing another `candidate_id`. Dispatch persists admitted scopes for recovery; role edits can narrow a running task but cannot widen its bound scope. Pre-upgrade interrupted tasks without a persisted scope cannot start new child execution; collection returns a durable `scope_migration_required` failure with `recoverable: false`. Committed child results may still be collected without execution or budget spending. Delegated Notebook grants without an explicit signed scope are refused and must be renewed.

Skill-local Researcher/Reviewer roles explicitly declare `execution_scope: workspace`; old Skill-local roles without a declaration retain a conservative Candidate ceiling for discovery, but dispatch refuses them with a specific missing-`execution_scope` diagnostic until their access is explicitly chosen. Custom/legacy restricted roles should add `execution_scope: candidate` explicitly, including copied Experimenter definitions. Runtime no longer grants or restricts tools by any particular Skill/role name. Preserve this declaration when copying or renaming a restricted role. Ordinary project roles retain workspace behavior unless restricted or assigned a Candidate.

Workspace policy grants project data/source with access to ordinary research protocols/scripts/results and explicit protection for credentials, hidden control paths, links and dependency directories. `node_modules` is excluded unless an operator supplies an external trusted dependency installation. Policy construction fails closed on excessive scans. Candidate policy grants only its budget-bound `input` (read) and `work` (read/write), plus trusted runtime dependencies. System binaries/libraries are readable. Network defaults to none; operators can grant role-specific public destinations through the profile policy. Arbitrary loopback access, Unix sockets, PTYs and weaker isolation modes remain disabled. Environment variables are rebuilt without model keys, MCP credentials, internal tokens or host proxy/socket variables.

Workers sign Notebook identity grants with the existing internal control-plane credential. New confined workers carry an opaque, service-owned execution-grant ID bound to their budget node; kernel endpoints revalidate that authority and the tool ceiling instead of resolving research directories. HTTP handlers verify signatures, expiry, workspace, candidate/budget binding and canonical directories, then derive policy themselves. Agent-generated `session_id`, `source`, `cwd` and policy-shaped JSON are not authorization identities. Missing grants give ordinary authenticated requests the workspace policy; they cannot obtain Candidate access. Candidate Notebook files must be regular, single-link, top-level `.ipynb` files in `input`/`work`; execution/output persistence requires `work`. Notebook file routes verify grants and use no-follow reads to prevent a running kernel from swapping a file for a link. Nested candidate notebooks are deliberately refused in this version. Create/edit candidate notebooks through sandboxed Bash.

Kernel cache keys include policy ID, owner where supplied, workspace, logical kernel identity, environment revision and language. Changed policy/environment retires the old namespace, including pending cold starts. Python interrupt targets the real bridge, preserving its namespace when it handles SIGINT. An unresponsive cell is terminated after the interrupt grace period and the next call creates a fresh kernel. Stop/restart, request disconnection and Worker exit terminate owned kernels. The trusted watchdog survives a stalled owner event loop, detects parent death/IPC disconnection and has an independent execution/lifetime deadline. Linux PID namespaces and parent-death behavior contain descendants. Kernel protocol output is capped at 16 MiB per cell; Bash retains upstream bounded display and output spill behavior.

Execution records include sandbox runtime, policy ID, execution mode and Notebook environment revision. Kernel artifact snapshots cover only authorized output roots and exclude denied paths. Candidate Bash/Notebook output detection starts at its own `work`, so sibling/evaluator changes are not published. Required-mode publication opens each path component with no-follow checks, captures a single-link regular file through its stable descriptor, and persists the exact bytes and digest. Publications are capped at 16 files / 8 MiB per execution; failures are retained in execution evidence. Candidate `read` formats an already-authorized byte snapshot, so an idle kernel cannot redirect its later file read. Bash refuses replay of an already recorded invocation; inspect its record and use a new invocation after uncertain completion.

## Validation

Run normal checks with `pnpm typecheck`, `pnpm test`, `pnpm build`. The Linux suite below requires actual isolation, not mocks. Cross-platform production-entry acceptance is documented in [Sandbox profiles](sandbox-profiles.md):

```bash
export PI_SCIENCE_SANDBOX_PYTHON=/trusted/python/bin/python3
export PI_SCIENCE_SANDBOX_PYTHON_ROOT=/trusted/python
export PI_SCIENCE_SANDBOX_SOCAT=/usr/bin/socat
export PI_SCIENCE_SANDBOX_RIPGREP=/usr/bin/rg
PI_SCIENCE_SANDBOX_TEST=1 \
  pnpm --filter @pi-science/server exec vitest run \
  src/runtime/sandbox/universal-sandbox.test.ts \
  src/runtime/agent/worker/confined-read-tool.test.ts \
  src/runtime/agent/agent-core-tools.test.ts
```

The suite covers main/child Bash with no enabled Skill, credential/file/network isolation, subprocess inheritance, multi-cell Python/streams, changed-policy namespaces, real interrupt and resistant-cell timeout/rebuild, Candidate HTTP and `notebook_run` with persisted output, forged authorization/mode rejection, shared budgets, candidate repair, ordinary Parent evaluation and Reviewer stop advice. Compatibility tests cover worker death, cancellation and detached descendant cleanup. Parent-driven evaluation runs through the same ordinary Bash/Notebook sandbox and publishes existing Execution/Artifact/Provenance evidence. Candidate scope does not inherit Parent research access.

### Linux CI host policy

Ubuntu runner images can ship the AppArmor `bwrap-userns-restrict` profile.
Its `unpriv_bwrap` child profile explicitly denies capabilities, preventing the
pinned `apply-seccomp` helper from creating nested namespaces even after the
generic user-namespace sysctl is relaxed. See the [upstream AppArmor policy](https://gitlab.com/apparmor/apparmor/-/blob/master/profiles/apparmor/profiles/extras/bwrap-userns-restrict)
and [sandbox-runtime compatibility report](https://github.com/anthropics/sandbox-runtime/issues/429).

The shared [CI-only host setup](../.github/scripts/configure-linux-sandbox.sh)
unloads that named profile only on disposable GitHub-hosted Linux VMs. It is not
called by installation, doctor or production startup, and refuses other hosts.
It does not grant workload capabilities or turn off the runtime's sandbox.
Acceptance first probes the packaged seccomp helper under real Bubblewrap, then
tests filesystem/network/credential isolation, active seccomp and no-new-privs,
and denial of workload CAP_SYS_ADMIN and read-write root remounts. Host policies
that still prevent startup fail the suite; no trusted-host fallback or test skip
is added. Production operators must explicitly resolve incompatible host policy;
the application continues to fail closed.

Native reads enforce workspace/protected-root boundaries and stable descriptors; macOS write/edit commits additionally use an OS-confined helper. Enabled skill resources are read-only. Local stdio MCP uses the same process layer and retains its separate tool authorization boundary. Hard CPU, memory, disk, GPU and cost quotas, hostile multi-tenant isolation, containers/VMs, providers and schedulers are outside this change. Long-lived Python kernels have a 24-hour watchdog ceiling. Operator-approved runtime dependencies and user-approved inputs must contain no secrets. Parent workspace policy permits authorized research scripts and data; Candidate policy remains input/work only. Truly confidential holdouts belong in external protected roots and are not a prerequisite for ordinary Skill evaluation. Missing sandbox/tools/dependencies are reported explicitly without host fallback.


The default Experimenter uses Bash/Notebook; sandbox_run registration and its dedicated executor have been removed. Historical evidence remains readable through Session/Execution/Artifact records. Migration instructions are maintained in [sandbox_run retirement](sandbox-run-compatibility.md); the current three-module Agent contract and unique research manifest are linked from [Auto Research](auto-research.md).


## Scope migration after upgrade

This applies to **all** Skill-local roles, including custom roles outside Auto Research. An old `document-audit/auditor` declaring read/write without `execution_scope` is still discoverable, but dispatch returns `code: scope_migration_required` naming the role and file before opening a Worker or spending a child budget. A Candidate ID or inherited restriction cannot suppress the missing-declaration diagnostic. Do not infer workspace access from its name, tools or current task text.

Review the role's intended access, then edit its trusted definition explicitly. For example, an ordinary workspace auditor at `.pi/skills/document-audit/agents/auditor.md` may declare:

```yaml
---
name: auditor
execution_scope: workspace
tools: [read, write]
---
```

Use `execution_scope: candidate` for restricted implementations and assign their Candidate through authenticated parent dispatch. Explicit workspace scope still intersects the Parent's active tools and cannot widen an inherited Candidate restriction. Redispatch the task after reviewing and saving the declaration; do not automatically add workspace scope to every old role.

For an interrupted task whose historical `executionScopes` are absent, the current role declaration cannot establish its original authority. Collection reuses already committed child results, but refuses any new child execution and persists `status: failed`, `error_code: scope_migration_required`, `recoverable: false` with re-run guidance. Single, chain and parallel tasks use the same outcome. Repeated collect/status calls and reopening the dispatcher retain that outcome without executing children or spending budget. Completed summaries/results remain readable.

Inspect prior results and possible side effects before re-running. After the role declaration is reviewed, dispatch a **new subagent invocation** under the remaining authorized budget. Preserve the old task/evidence; do not edit its persisted scopes, silently retry uncertain work or infer historical workspace authority from today's role file.


## Generic confined grants

A `subagent` task may request `sandbox: {cwd, read_paths, write_paths}`. These are untrusted selections: authenticated parent dispatch canonicalizes and validates existing directories, requires parent read/write containment, binds private state to the exact task/budget subtree, and always forces offline required-mode confinement. `cwd` must be writable; explicit read-only input roots and output roots must be disjoint. Protected names, operator roots and service state remain unavailable. Selected directory identities and linked/special files are checked before use. The immutable grant is not accepted from model parameters; tool schemas reject raw network/mode/grant-ID overrides.

The grant records exact tool ceilings, budget owner/node, roots and the parent's grant when present. A child cannot change the admitted roots during recovery, widen parent tools/deadlines or escape its budget ancestry. `candidate_id` on this path is correlation only; arbitrary Draft/Patch directory layouts need no research budget scope. The legacy Auto Research adapter resolves old Candidate-only requests separately; the historical sandbox_run executor has been removed. Legacy workers/kernel grants without opaque authority fail closed until rebound through dispatch.

The independent launcher polls grant/config source hashes plus the actual budget tree every 250 ms. Revocation, operator-policy changes, budget cancellation or shortened deadlines terminate active processes/persistent kernels. Missing or invalid authority fails closed. The normal ownership watchdog and descendant cleanup remain in place; stable policy identity keeps Notebook state between authorized calls. File tools cannot modify the grant directory.

A Parent controls which ordinary files to delegate. Validation cannot infer the intended scientific meaning of a directory named `input` or `work`. Keep evaluator/decision history/sibling roots out of child selections; use protected operator roots for genuinely confidential data. No workload can turn its own paths or Candidate IDs into authority without server validation.

## Confined authorization cost

Per-call confined authorization checks current grant/config sources, budgets, directory identities, sensitive ancestors and the granted directory trees. Inaccessible workspace siblings are excluded from its protection scan; initial broad workspace admission still validates the workspace. No cross-call authorization cache is used. Confined reads capture with the policy revalidated inside their file lock. The bounded benchmark, reproduction command and local before/after measurements are in [Confined authorization benchmark](performance/execution-grants-benchmark.md).

## Delegated tool inheritance

Builtin, project and Skill-local roles follow one rule: omitted `tools` inherits the Parent's currently authorized eligible active tools; an explicit role list narrows that set, and `tools: []` selects none. A delegation's optional `tools` list further restricts it. Exact MCP capability names are checked at runtime; roles need no provider enumeration or separate retrieval registry. The existing questionnaire/retired-tool restrictions, scope ceiling, MCP/user approvals and per-call revocation checks still apply. Inheritance never supplies missing `execution_scope` or a Sandbox Grant.

Admission persists each effective tool set. Restore/resume and every delegated invocation intersect it with current Parent/role permissions; editing a role or enabling a new Parent tool cannot widen an existing task. An interrupted task without a tool snapshot cannot infer historical authority from current definitions: inspect prior results and dispatch a new invocation. Committed results remain readable without executing again.

Workspace-scoped Researcher/Reviewer roles can inherit side-effectful tools already active in the Parent. Read-only instructions express task intent, not enforced permissions; supply a narrowed per-task tool list for strict read-only work. Confined Experimenters remain limited to read/Bash/Notebook and a validated grant even when their role omits `tools`.


## Skill helper resources

Each workspace Bash invocation adds read-only access to the current Harness's
enabled directory-based Skills (`SKILL.md` plus helpers, references and assets).
This allows commands such as `python -B .pi/skills/stats-integrity/stats_integrity_check.py study.md`
while keeping the rest of `.pi`, including configuration and prompts, hidden.
Explicitly configured external Skill directories receive the same narrow read
access; their parent and sibling directories receive no additional permission.

Skill resource directories are not writable. Helpers should write results to the
workspace or `$TMPDIR`, rather than beside their source files. Existing credential,
symlink, hardlink and service-data restrictions still apply inside resource trees.
Standalone `.md` Skills do not authorize their shared parent directory. Confined
and Candidate workers do not inherit these extra reads; they keep their explicit
execution grant. Runtime dependencies and package installation remain separate.

The directory list is read from current Harness resources for each Bash call, so
Skills policy changes and refreshes affect subsequent invocations without a Worker
restart. An already admitted invocation retains its original sandbox policy.

The pinned SRT 0.0.79 dependency carries a pnpm patch for macOS Seatbelt read-rule generation. When a literal parent denial is restored after the workspace allow, it excludes explicitly allowed literal child directories. This preserves enabled Skill helper reads under `.pi` while leaving sibling directories and independently denied sensitive descendants inaccessible. Literal path semantics also apply to project names containing glob characters. The platform acceptance suite runs real helper execution on both Linux and macOS; the [Skill policy benchmark](performance/skill-resources-benchmark.md) records the cost of scanning enabled resource trees on every Bash invocation.
