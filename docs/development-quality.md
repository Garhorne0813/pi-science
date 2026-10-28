# Development verification

`pnpm lint` checks the frontend and server. Server lint includes unused-variable
and correctness rules plus type-aware `no-floating-promises` across `src`.
`no-misused-promises` additionally covers security, credential and model-config
production paths. Tests may use async callbacks provided by their test harness.
An intentional background operation must handle rejection, not merely add
`void` to silence the checker. Run `pnpm typecheck` for all package types.

`pnpm test` runs contracts, server and frontend in parallel with at most two workers
per package, then the Skill suite. The cap prevents three independent Vitest
pools from oversubscribing a runner. Frontend tests use UTC for reproducible
date/time form assertions.
Skills run afterward to avoid starting two server Vitest suites simultaneously.
The Windows CI server suite keeps `--fileParallelism=false` because process-tree
integration tests compete for native process capacity.

The quality workflow separates static checks, unit/integration tests, builds
with backend budgets/smoke tests, and browser checks. Browser checks consume the
Linux frontend build artifact. The existing `verify (ubuntu-latest)` and
`verify (windows-latest)` names aggregate all applicable jobs. Only `docs/**`
and root README changes can skip expensive jobs; the aggregators still run.
Markdown under Skills and agent definitions continues to trigger verification.
All workflows cancel superseded runs for the same workflow/ref.

Shell scripts are checked with `shellcheck -S warning scripts/*.sh scripts/fixtures/*.sh`.
Windows CI pins PSScriptAnalyzer 1.24.0 and checks the correctness/security rules
in `.github/PSScriptAnalyzerSettings.psd1`, including parse errors. Script checks
supplement the real launcher and process-ownership tests.

Test/source line counts are not coverage measurements. Before adding a security
test, identify a missing boundary or failure case. Credential regressions live
in `apps/server/src/model-resources/model-resources.test.ts`, the model-config
suites and HTTP route suites. They exercise secret exposure, POSIX permissions,
backend switching, ownership, migration and OAuth refresh concurrency.
