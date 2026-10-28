# Workspace discovery tools

The native Harness tools `ls`, `glob`, and `grep` operate inside the current workspace, including in full sessions. They do not search home directories or external Skill roots. Candidate/confined agents do not receive them. Workspace delegates remain subject to parent active tools, role declarations and the existing per-call capability approval.

```text
ls({path: "data"})
glob({pattern: "**/*.{csv,tsv}", path: "data"})
grep({pattern: "read_csv|csv.reader", path: "analysis", glob: "**/*.py"})
```

Paths are relative to the workspace and use `/`. Absolute, Windows drive/UNC, parent traversal and NUL paths are rejected. Returned paths can be passed to `read`. `ls` returns one level of `entries`; `glob` returns regular `files`; `grep` returns `matches` with path, 1-based line and text. Every successful response includes `limit`, `truncated` and, when incomplete, `truncationReason`.

## Implementation and boundaries

Shared read authorization comes from `runtime/sandbox/workspace-read-authorization.ts`. Existing file tools retain full-mode and Skill-root behavior. Discovery uses the narrower workspace boundary and omits protected subtrees without exposing their names or counts. Hidden entries, sensitive names, symlinks, special files and multi-link files are excluded independently of ignore patterns. Protected-root ancestors may be enumerated without granting access to their protected descendants.

Linux traversal pins every ancestor using `O_DIRECTORY | O_NOFOLLOW` and reads through `/proc/self/fd`. File contents use the existing bounded `readRegularFile` descriptor reader. Returned entries undergo a final validation through pinned parents and a freshly loaded operator policy. The tools do not start a shell/search process, write workspace files, make network requests or consume Bash execution budgets.

Matching and ignore parsing run in a disposable worker thread. The parent enforces a five-second deadline, handles cancellation, and terminates the thread before releasing its concurrency slot. This is an isolation boundary for computation and lifecycle, not an OS sandbox. Filesystem access is constrained by the descriptor reader and authorization layer. Required mode never falls back to a host search executable; invalid execution-mode configuration fails closed.

`grep` uses RE2/WASM for bounded regular-expression matching, not JavaScript backtracking regex or PCRE2. Lookaround, backreferences, multiline patterns and embedded newline/NUL patterns are unsupported. `literal: true` escapes regex operators. `ignoreCase` defaults to false. Binary/NUL and invalid UTF-8 files are skipped. Large files are skipped with `scan_budget` truncation. Lines are deduplicated by file/line, terminal controls are removed, and previews stop at 512 Unicode characters. Search content remains untrusted data.

`glob` uses picomatch for `*`, `?`, `**`, character classes and braces; extglobs and negation are rejected. `ignore` implements per-directory `.gitignore` rules including negation and ancestor rules for explicitly narrowed search roots. Ignored directories are pruned. Ignore metadata is read only to determine filtering; it is never emitted or searched. Missing ignore files are permitted; unsafe or unreadable ignore metadata fails closed. Ignore rules never override authorization.

## Fixed budgets

| Budget | Default / hard maximum |
| --- | --- |
| ls entries | 200 / 500 |
| glob files | 500 / 1000 |
| grep matching lines | 100 / 200 |
| Pattern length | 256 characters |
| Output JSON | 64 KiB |
| Match preview | 512 Unicode characters |
| Searchable file | 8 MiB |
| Ignore metadata file | 64 KiB |
| Total captured text and ignore metadata | 64 MiB |
| Raw directory entries examined | 20,000 |
| Recursive depth | 20 below requested root |
| Wall clock including worker startup | 5 seconds |
| Concurrent calls per Agent Worker | 2; excess calls fail with resource_limit |

Output and quantity limits return explicitly truncated results. Exhausted traversal/depth/scan budgets return `resource_limit`; timeout/cancellation never becomes a complete empty success. Errors use stable sanitized codes: `invalid_input`, `access_denied`, `not_found`, `unsupported_pattern`, `tool_unavailable`, `resource_limit`, `cancelled`, `timeout`.

## Sessions and platform status

New ordinary sessions activate the tools by default. Old idle ordinary sessions with active `read` migrate once before Harness opens its lane. Selection and `discovery-tools-version=1` commit in one SDK transaction. Later manual disabling is retained. Explicit `allowedTools`, delegated/candidate/confined sessions, and active recovery operations do not gain tools through migration. Busy old sessions defer migration until a later idle reopen. No JSONL editing is used.

Only Linux is enabled. macOS and Windows return `tool_unavailable` until equivalent directory/junction guarantees have real native acceptance evidence. `pi-science doctor` reports descriptor and RE2 backend availability. Discovery itself needs no ripgrep installation; existing Bash sandbox prerequisites still apply.

Tests cover real Linux filesystem traversal, symlinks/hardlinks, protected paths, a concurrent helper process swapping a directory for an external symlink, strict inputs, ignore rules, Unicode/control text, resource budgets, cancellation and session migration. The sandbox acceptance workflow also runs these tests alongside existing OS isolation tests. Its Linux job builds the server and runs `apps/server/scripts/verify-workspace-discovery.mjs` inside Bubblewrap with a read-only host root and no network; only its disposable `/tmp` is writable. Passing these tests does not claim native macOS/Windows support or exhaustive proof against every filesystem race.

For rollback, remove the independent tool registration, migration hook and discovery modules, keeping existing file tools. No workspace data/index migration is created. The SDK version marker can remain inert.

## Implementation verification — 2026-10-28

On Linux at repository baseline `46544d1e30b3377b7e0087e624c796821397e679`:

- `pnpm typecheck` and `pnpm build` passed; the existing frontend large-chunk notice remains.
- Discovery/authorization/file-tool/session/role/delegation regression: 6 files, 88 passed, 1 skipped.
- Frontend activity/projection and previously timed-out page regression: 6 files, 130 passed.
- Previously timed-out server lifecycle/client/business/app regression, rerun serially: 4 files, 97 passed, 7 skipped.
- Doctor tests: 5 passed; new-module Oxlint and `git diff --check` passed.
- The compiled acceptance script passed inside real Bubblewrap with read-only host mounts, a disposable writable `/tmp`, and network disabled.

The complete parallel `pnpm test` run was stopped after timing failures on the two-core execution environment; the serial regressions above do not imply full-suite success. `pnpm smoke` first lacked sandbox helpers; configuring the existing `PI_SCIENCE_SANDBOX_RIPGREP` / `PI_SCIENCE_SANDBOX_SOCAT` overrides resolved that prerequisite, but scientific-environment provisioning then failed on conda-forge TLS downloads. Complete smoke/agent-core smoke and native macOS/Windows release acceptance remain unverified.

## Real-model acceptance — DeepSeek Flash / high

An explicit paid live test is available at `apps/server/src/runtime/agent/workspace-discovery.live.test.ts`. Supply `DEEPSEEK_API_KEY` in the process environment, then run:

```bash
PI_SCIENCE_DISCOVERY_LIVE_TEST=1 pnpm --filter @pi-science/server exec vitest run src/runtime/agent/workspace-discovery.live.test.ts --maxWorkers=1
```

The test uses independent production Agent Workers and the canonical `models.json` configuration with an environment-backed credential reference. A local audit gateway forwards unchanged requests/responses only to `https://api.deepseek.com/v1/chat/completions`, through the configured environment proxy with normal TLS verification. Before forwarding, it rejects requests unless the model is `deepseek-flash`, thinking is enabled and `reasoning_effort` is `high`. Each test run permits at most 12 upstream requests and sends only synthetic fixtures.

The successful 2026-10-28 acceptance run completed in 21.8 seconds with 9 upstream requests, all HTTP 200 and all returning model `deepseek-flash`. These three scenarios passed:

1. Actual ordered `ls → glob → grep → read` calls found the expected CSV, identified both Python/R loader lines, and produced the expected analysis entry point. Ignore rules, protected-name/link filtering and unchanged public-file hashes were checked.
2. Three simultaneous invalid search calls produced one `resource_limit` and the corresponding controlled permission/input errors for the two admitted calls.
3. A separate single-file search of `.env` returned `access_denied` without contents or host paths.

Reports under `work/live-tests/` contain request flags, response metadata/token usage and synthetic tool results, without credentials or reasoning text. Temporary session/provider state is removed after the test. The default unit-test run skips this paid test unless explicitly enabled. This acceptance supplements the deterministic safety tests; it does not imply full-suite or additional-platform acceptance.
