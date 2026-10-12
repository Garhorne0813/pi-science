# Installation and local production deployment

[简体中文](deployment.zh-CN.md) · [README](../README.md)

The supported source install builds contracts, the Node control plane, Agent Workers,
SQLite assets, kernel bridges and the React frontend. Production serves the browser
and API on `http://127.0.0.1:8787`. Node.js >=24.16.0 with npm is required; npm
bootstraps the exact `packageManager` version from package.json into its cache.
Registry access is needed during installation. Startup does not download packages.

| Task | macOS / Linux | Native Windows |
| --- | --- | --- |
| Install and build | `bash scripts/install.sh` | `powershell -File scripts/install.ps1` |
| Diagnose | `bash scripts/pi-science.sh doctor` | `powershell -File scripts/pi-science.ps1 doctor` |
| Production start | `bash scripts/start.sh` | `powershell -File scripts/start.ps1` |
| Development start | `bash scripts/start.sh --dev` | `powershell -File scripts/start.ps1 -Dev` |
| Stop detached/owned services | `pi-science stop` | `pi-science stop` |

`pi-science` is installed into the user bin directory. Bash also supports `start
--detach --no-open`; PowerShell stays in the foreground. Both support `status`,
`logs`, `install` and `doctor`. Logs are checkout-local under `.runtime/pi-science`.
Application data and workspace directories retain their existing configuration.

`PI_SCIENCE_FRONTEND_DIST` accepts an absolute path or a path relative to the checkout
root, independent of the directory from which the launcher or doctor is invoked.
The launcher resolves it to an absolute path before validation and child startup.

On Windows, `logs` defaults to all control-plane/frontend stdout and stderr files,
with a filename heading for each stream; `logs --stderr` selects only error streams
and `logs --all` explicitly selects all streams. They are displayed by file, not
interleaved by timestamp. Windows foreground startup writes service output to these
files. POSIX foreground output stays in the terminal; `logs` reads the file written
by `start --detach`, which may be from a previous detached run.

`doctor` exits 1 for a required check failure and 2 for invalid arguments. It does
not install software, initialize a persistent database, contact an LLM, or test
network download availability. Missing data directories are checked through their
nearest existing ancestor without creating them. Optional scientific environments
and provider setup are reported separately. Run it before startup: occupied ports
are reported as conflicts even if another Pi-Science instance owns them.

POSIX readiness and status probes use the required Node.js runtime, so starting the application does not require `curl`. Each HTTP request has a 2-second wall-clock limit covering connection, headers and body, capped by the remaining shared startup deadline. After the deadline, startup rolls back its owned services without another probe.

## Failure recovery

- Missing build/dependency: rerun the platform installer. Production builds must
  be refreshed after source changes. Use `start --dev` while editing source.
- Port occupied: inspect `status` and stop the known application or choose another
  `PI_SCIENCE_CONTROL_PLANE_PORT`. Stop never kills an unknown listener by port.
- Windows stop reports `stopped`, `already_exited`, `unverified`, or `failed`
  internally. An incomplete stop exits 1 and preserves the complete identity record
  for retry, including after CIM failures, kill errors or exit timeouts. State is
  removed only when both roles are confirmed exited or their identities are stale.
  A descendant stop failure leaves the parent alive so a retry can still find it.
  Each descendant must be born no earlier than its snapshot parent; a recycled
  parent PID cannot include an older foreign process or that process's subtree.
  The snapshot root is anchored to the verified process, and ancestor creation
  times are rechecked before signaling a descendant. Changed ancestry fails closed.
  Port diagnostics use the recorded deployment mode/ports when available, otherwise
  the selected mode: production checks only the control-plane port. A missing
  record plus an occupied relevant port reports an unverified listener, not ownership.
- Lost or stale Windows state: inspect the process manually; do not guess ownership
  from the listening port. Legacy state without identity is intentionally refused.
- After a crash or a forced Windows stop, the existing application instance lock
  has a 30-second recovery grace period. `doctor` reports active or recent locks;
  wait for that grace period before restarting.
- Startup error: inspect `pi-science logs` and Windows `*.log.err` files. Startup
  failure cleans up owned processes; internal random-token generation fails closed.
- Data migration error: preserve the original data and restore a full backup with
  the compatible application version. Do not treat a Git downgrade as a data rollback.

The launcher binds to loopback. The frontend's internal HttpOnly cookie is not an
independent user identity or authorization system; remote multi-user deployment
requires a separate design for authentication and authorization.

## Acceptance and remaining work

`node --test scripts/doctor.test.mjs scripts/check-http-health.test.mjs` covers diagnostic failures and HTTP request deadlines, including stalled headers and continuously streaming bodies.
`bash scripts/test-launcher.sh` covers source-mode lifecycle and process fencing with an unusable `curl`, including hung HTTP startup and cleanup in foreground and detached modes.
`powershell -File scripts/test-process-identity.ps1` covers missing/stale identity,
checkout/entry/token mismatch and valid ownership. Its CIM mocks are portable.
`node scripts/smoke-production.mjs` uses real compiled artifacts and the platform
launcher to check SQLite readiness, HTML, JS assets, SPA fallback, authenticated
API, state/status, stopping and protection of foreign listeners. The CI production
job runs the actual installer without a pnpm setup step on Linux, macOS and Windows.
No API key or Python/R installation is needed for these acceptance checks.

Future work: versioned releases and independent install packages, a transactional
updater with stopped-state data backup and recovery, and uninstall that preserves
user data by default. These commands are not implemented by this change. Backups
must include application state and workspace-owned metadata; see [data ownership](architecture.md#persistence-and-data-ownership).
