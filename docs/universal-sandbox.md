# Universal process sandbox

## Live DeepSeek smoke test

`apps/server/src/runtime/agent/deepseek-sandbox.live.test.ts` calls the official DeepSeek API with `deepseek-flash` through the product's provider routing and real Agent Workers. It verifies main/authorized-child Bash execution, protected-file and credential isolation, execution policy evidence and captured artifacts. It does not replace the separate Python Notebook acceptance tests. The live test is skipped by default and incurs provider usage when enabled.

Supply `DEEPSEEK_API_KEY` through the process environment, allow outbound HTTPS to `api.deepseek.com`, and configure the Linux sandbox dependencies described below. The test explicitly forwards that environment-backed credential to the Worker; Workers intentionally do not inherit ambient provider secrets, and sandboxed tools never receive it. The credential store saves only the environment-variable reference; temporary test settings and transcripts are deleted on completion. Run from the repository root:

```bash
PI_SCIENCE_DEEPSEEK_LIVE_TEST=1 pnpm --filter @pi-science/server exec vitest run src/runtime/agent/deepseek-sandbox.live.test.ts
```

A proxy `CONNECT` 403 means the request has not reached DeepSeek and cannot establish whether the API key or model is valid. A skipped live test is not evidence of API success.

Based on PR #157 (`e2634fb89fe10f355224941d42adddfe1ae8e093`), Bash and Python Notebook now use the pinned `@anthropic-ai/sandbox-runtime@0.0.79` execution layer independently of Skills. Bash retains its name, schema, upstream output capture/checkpoints and budget wrapper. Python kernels retain the JSONL bridge, rich outputs, streaming and shared variables between cells. HTTP `execute` and `execute-stream` enforce the same server policy as agent tools.

## Operator configuration

`PI_SCIENCE_EXECUTION_MODE` defaults to `required`. Sandbox setup failures refuse execution; there is no host fallback. Linux x64/arm64, Bubblewrap, socat, ripgrep and the packaged Unix socket seccomp filter are required. macOS and Windows fail closed in required mode. R Notebook kernels are blocked in required mode pending separate platform acceptance.

Set optional absolute binary paths with `PI_SCIENCE_SANDBOX_SOCAT` and `PI_SCIENCE_SANDBOX_RIPGREP`. Optional `PI_SCIENCE_SANDBOX_RUNTIME_PATHS` is a JSON array of narrow, administrator-approved read-only dependency paths for Bash. `PI_SCIENCE_SANDBOX_PYTHON_ROOT` also grants its trusted preinstalled environment to Bash. A server-selected workspace environment prefix takes precedence on PATH, stays read only and contributes its revision ID to execution evidence. Broad system/home roots and dependencies overlapping writable workspace paths are refused. There is no package installation permission. Python Notebook uses the environment revision selected by the server; its prefix must be outside writable workspace paths. The server installation, launcher, Node/srt runtime and bridge must likewise be outside writable workspace paths; overlap fails closed so code cannot rewrite a future trusted launcher. Aliases resolving to broad dependency roots are refused too.

An optional private `PI_SCIENCE_SANDBOX_READ_POLICY` file can bound dependency grants and protect service-owned data. Its format is `{ "schemaVersion": 1, "dependencyRoots": ["/srv/pi-runtime"], "protectedRoots": ["/srv/private-data"] }`. All listed paths must exist; the file must be operator-owned, single-link and mode 0600 outside writable workspaces. Protected roots cannot overlap effective runtime reads/writes. The Worker receives the path only from server launch configuration. Ordinary Auto Research needs no such file. Stop active workloads before changing roots; subsequent Notebook cells retire stale namespaces, and changed admission digests fail before startup.

An administrator can explicitly set `PI_SCIENCE_EXECUTION_MODE=trusted-host` for trusted workspace operations. This is service configuration, never a tool argument, prompt, workspace setting or request-body option. Candidate Bash/Notebook always require isolation even when ordinary workspace execution is authorized on the host. Compatibility `sandbox_run` retains its original `PI_SCIENCE_SANDBOX_ENABLED=1` and dedicated Python installation requirements.

## Authorization and process lifecycle

Tool permissions and filesystem policy are separate. Main and child permissions continue through AgentHarness, parent intersection and per-call delegated capability rechecks. Candidate binding is inherited by nested children and cannot be widened by choosing another `candidate_id`.

Workspace policy grants project data/source with access to ordinary research protocols/scripts/results and explicit protection for credentials, hidden control paths, links and dependency directories. `node_modules` is excluded unless an operator supplies an external trusted dependency installation. Policy construction fails closed on excessive scans. Candidate policy grants only its budget-bound `input` (read) and `work` (read/write), plus trusted runtime dependencies. System binaries/libraries are readable. Network, loopback access, Unix sockets, PTYs and weaker isolation modes are disabled. Environment variables are rebuilt without model keys, MCP credentials, internal tokens or host proxy/socket variables.

Workers sign Notebook identity grants with the existing internal control-plane credential. HTTP handlers verify signatures, expiry, workspace, candidate/budget binding and canonical directories, then derive policy themselves. Agent-generated `session_id`, `source`, `cwd` and policy-shaped JSON are not authorization identities. Missing grants give ordinary authenticated requests the workspace policy; they cannot obtain Candidate access. Candidate Notebook files must be regular, single-link, top-level `.ipynb` files in `input`/`work`; execution/output persistence requires `work`. Notebook file routes verify grants and use no-follow reads to prevent a running kernel from swapping a file for a link. Nested candidate notebooks are deliberately refused in this version. Create/edit candidate notebooks through sandboxed Bash.

Kernel cache keys include policy ID, owner where supplied, workspace, logical kernel identity, environment revision and language. Changed policy/environment retires the old namespace, including pending cold starts. Python interrupt targets the real bridge, preserving its namespace when it handles SIGINT. An unresponsive cell is terminated after the interrupt grace period and the next call creates a fresh kernel. Stop/restart, request disconnection and Worker exit terminate owned kernels. The trusted watchdog survives a stalled owner event loop, detects parent death/IPC disconnection and has an independent execution/lifetime deadline. Linux PID namespaces and parent-death behavior contain descendants. Kernel protocol output is capped at 16 MiB per cell; Bash retains upstream bounded display and output spill behavior.

Execution records include sandbox runtime, policy ID, execution mode and Notebook environment revision. Kernel artifact snapshots cover only authorized output roots and exclude denied paths. Candidate Bash/Notebook output detection starts at its own `work`, so sibling/evaluator changes are not published. Required-mode publication opens each path component with no-follow checks, captures a single-link regular file through its stable descriptor, and persists the exact bytes and digest. Publications are capped at 16 files / 8 MiB per execution; failures are retained in execution evidence. Compatibility `sandbox_run` reuses shared policy/settings, launcher, scoped file capture and process-group cleanup while preserving its replay, reset and bounded artifact behavior. Candidate `read` formats an already-authorized byte snapshot, so an idle kernel cannot redirect its later file read. Bash refuses replay of an already recorded invocation; inspect its record and use a new invocation after uncertain completion.

## Validation

Run normal checks with `pnpm typecheck`, `pnpm test`, `pnpm build`. Real acceptance requires actual Linux isolation, not mocks:

```bash
export PI_SCIENCE_SANDBOX_PYTHON=/trusted/python/bin/python3
export PI_SCIENCE_SANDBOX_PYTHON_ROOT=/trusted/python
export PI_SCIENCE_SANDBOX_SOCAT=/usr/bin/socat
export PI_SCIENCE_SANDBOX_RIPGREP=/usr/bin/rg
PI_SCIENCE_SANDBOX_TEST=1 PI_SCIENCE_SANDBOX_ENABLED=1 \
  pnpm --filter @pi-science/server exec vitest run \
  src/runtime/sandbox/universal-sandbox.test.ts \
  src/runtime/agent/worker/sandbox-tool.test.ts \
  src/runtime/agent/agent-core-tools.test.ts
```

The suite covers main/child Bash with no enabled Skill, credential/file/network isolation, subprocess inheritance, multi-cell Python/streams, changed-policy namespaces, real interrupt and resistant-cell timeout/rebuild, Candidate HTTP and `notebook_run` with persisted output, forged authorization/mode rejection, shared budgets, candidate repair, ordinary Parent evaluation and Reviewer stop advice. Compatibility tests cover worker death, cancellation and detached descendant cleanup. Parent-driven evaluation runs through the same ordinary Bash/Notebook sandbox and publishes existing Execution/Artifact/Provenance evidence. Candidate scope does not inherit Parent research access.

Read/write/edit remain outside this process sandbox and additionally enforce workspace/protected-root boundaries; enabled skill resources are read-only. MCP retains its separate authorization boundary. Hard CPU, memory, disk, GPU and cost quotas, hostile multi-tenant isolation, containers/VMs, providers and schedulers are outside this change. Long-lived Python kernels have a 24-hour watchdog ceiling. Operator-approved runtime dependencies and user-approved inputs must contain no secrets. Parent workspace policy permits authorized research scripts and data; Candidate policy remains input/work only. Truly confidential holdouts belong in external protected roots and are not a prerequisite for ordinary Skill evaluation. Missing sandbox/tools/dependencies are reported explicitly without host fallback.


The default Experimenter uses Bash/Notebook; sandbox_run is compatibility-only and omitted from that role declaration. Its registration and authorized historical replay remain available. Migration differences and removal gates are maintained in [sandbox_run compatibility](sandbox-run-compatibility.md); the current three-module Agent contract and unique research manifest are linked from [Auto Research](auto-research.md).
