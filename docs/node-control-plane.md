# Node control-plane migration

**Current status (2026-07-24):** implemented and accepted. The only
release-gated item is deleting the retained Python compatibility modules after
a stable release cycle.

Pi-Science now exposes a Node.js/TypeScript gateway as its public backend. The
Python process remains the internal scientific runtime while services migrate
incrementally.

```text
React (5173) → Node control plane (8787) → Python scientific runtime (8788)
```

The Node gateway owns the public listener, CORS, health response and the
control-plane API. Python remains the owner of the scientific routes:

- `/api/kernels`
- `/api/notebooks`
- `/api/pdfs`
- `/api/figures`
- `/api/literature`

The remaining public scientific-control routes are retained behind the gateway
as an internal compatibility fallback, but the default Node owner is now the
native TypeScript implementation for jobs, artifacts, provenance, settings,
model endpoints, skills, MCP, workspaces, compute registry, runs, project
knowledge/memory, citations, bookmarks and result reviews.

Session/Pi ownership flags remain independently switchable and default to the
Node-native implementation. Sessions are no longer read-only in Node: create,
prompt, abort, compact, model/thinking, interaction, switch, fork, export and
delete are all Node-owned.

```text
PI_SCIENCE_NODE_SESSIONS=1       # Node session repository and lifecycle
PI_SCIENCE_NODE_SSE=1            # Node-native SSE broker and event persistence
PI_SCIENCE_NODE_FILES=1          # Node file read/write routes
PI_SCIENCE_NODE_PI_MANAGER=1     # Node Pi JSONL process and command routes
```

Business route groups default to Node and can be rolled back independently:

```text
PI_SCIENCE_NODE_JOBS=0|1
PI_SCIENCE_NODE_ARTIFACTS=0|1
PI_SCIENCE_NODE_SETTINGS=0|1
PI_SCIENCE_NODE_CATALOG=0|1
PI_SCIENCE_NODE_PROJECT=0|1
PI_SCIENCE_NODE_FILES=0|1
```

When `PI_SCIENCE_REQUIRE_INTERNAL_TOKEN=1` is enabled, Python rejects direct
business API access without `x-pi-science-internal-token`; Node injects the
token on its internal proxy requests. `scripts/dev.sh` and the smoke script
enable this boundary automatically.

Run the split runtime with:

```bash
bash scripts/dev.sh
```

Or run the Node gateway against an already-running Python runtime:

```bash
PI_SCIENCE_PYTHON_ORIGIN=http://127.0.0.1:8788 pnpm dev:server
```

The remaining release work is to remove the legacy Python control-plane
modules after a release-cycle audit. Session commands and their SSE stream
have a single owner: when the Node Pi manager is enabled, neither path falls
back to Python.

Pi subprocesses use a workspace-scoped `PI_CODING_AGENT_DIR` under
`PI_SCIENCE_HOME/pi-agent/<workspace-hash>`. This prevents Pi's global
`~/.pi/agent` lockfile from breaking startup in managed environments.
The optional `context-mode` Pi extension is disabled by default and can be
enabled explicitly with `PI_SCIENCE_ENABLE_CONTEXT_MODE=1`.

Provider/model behavior:

- API keys and custom providers are serialized through atomic settings writes.
- Keyless custom providers are valid and appear in the model selector.
- Saving settings refreshes existing Pi runtimes; busy runtimes refresh after
  the active turn settles.
- Runtime refresh failures are returned to the UI instead of being reported as
  successful saves.
- With no configured model, the composer shows a configuration message and
  disables Send.

Conversation acceptance commands:

```bash
# Gateway and native route baseline (does not require an LLM credential)
pnpm smoke

# Real Pi JSONL lifecycle: create/state/SSE/prompt when a model is present,
# switch, fork, delete, health count, and Node ownership headers
PI_CLI_PATH=/absolute/path/to/pi pnpm smoke:real-pi

# Browser conversation UAT against already-running frontend and Node backend
pnpm uat:conversation
```

The real-Pi smoke isolates `PI_SCIENCE_HOME` and the workspace in a temporary
directory. A configured model may complete successfully or produce a terminal
model/provider error; either outcome must arrive through Node-native SSE and
settle the turn. The browser UAT creates the required `.pi-science/` workspace
marker and rejects any session response whose `x-pi-science-runtime` is not
`node-control-plane` or whose SSE header is not `node-native`.

## Acceptance snapshot

The migration was accepted on 2026-07-24 with:

```text
Node server:     10 test files, 49 tests passed
Frontend:        10 test files, 68 tests passed
Python runtime:  266 passed, 21 skipped
Production build: passed
Baseline smoke:   passed
Real Pi smoke:    passed
Browser UAT:      passed
```

The acceptance suite covers prompt/compact timeouts, cancelled RPCs, failed
state reconciliation, runtime restart rollback, A→B→A switching, blank session
replacement, multi-tab/replay de-duplication, bounded SSE backpressure,
`stream.gap` snapshot recovery, exact provider errors, keyless custom
providers, settings-triggered runtime refresh, fork/export/delete and Pi crash
terminal events.

## Compatibility note

The legacy `PI_SCIENCE_NODE_PI_MANAGER=0` compatibility mode still opens one
Python SSE upstream per browser tab. Events are de-duplicated before durable
persistence, so this does not duplicate conversation records. A future cleanup
may replace those compatibility connections with a shared session-level
upstream; the default Node-native mode already uses a central fan-out hub.

The executable atomic roadmap and smoke-test matrix are documented in
[`node-typescript-backend-atomic-plan.md`](node-typescript-backend-atomic-plan.md).
