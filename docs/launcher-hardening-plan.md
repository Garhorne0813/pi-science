# Launcher hardening plan

## Purpose

Harden the installed local-development launcher without changing Pi-Science into a production deployment. The launcher continues to run `tsx watch` for the Node control plane and the Vite development server for the React SPA, but it must own the long-lived processes it starts, stop them predictably, and fail safely when the checkout or dependencies are invalid.

## Root causes

1. `scripts/start.sh` starts the control plane through `pnpm --filter ... dev` and the frontend through `npm run dev`. The recorded PIDs belong to package-manager wrappers rather than necessarily to the `tsx` and Vite processes holding the ports. Signal forwarding and startup-failure cleanup can therefore leave descendants behind.
2. Replacing those wrappers with absolute CLI paths without preserving package working directories would change `process.cwd()` and Vite/config resolution. The control plane must still start from `apps/server`; Vite must still start from `frontend`.
3. The runtime launcher checks only Node's major version even though the installed Vite requires Node `^20.19.0 || >=22.12.0`. This project standardizes on Node `>=22.12.0`.
4. Readiness waits are an accidental 30 × 0.5 second loop, shorter than the outer launcher's intended startup allowance.
5. Frontend reuse trusts only the listener process CWD. That is not a reliable identity check and can attach this checkout to an unrelated service.
6. `scripts/install.sh` writes the PATH launcher directly. Shell redirection follows symlinks and overwrites unrelated files, and an interrupted write can leave a partial launcher.
7. Detached launcher state trusted a bare PID and swept checkout-local listeners during rollback. Stale/PID-reused state could signal an unrelated process, and a pre-existing listener could be killed despite not belonging to the launch.
8. Job orphan healing treated a nonterminal record absent from the current coordinator's memory for 15 seconds as failed. A second coordinator—or delayed terminal persistence on Windows—could therefore fail a healthy job because durable records lacked owner identity, fencing and a renewable lease.

## Approved decisions

- This remains a local checkout/development launcher. Keep `tsx watch` and Vite dev mode.
- Shell launchers support macOS/Linux and Bash environments on Windows such as WSL or Git Bash. Native PowerShell/CMD launchers are out of scope.
- PATH-launcher collision and symlink hardening is included as an independently reviewable change.
- Job restart behavior uses fail-and-reap semantics. The server does not claim to adopt stdout/stderr or exit status from a child created by a dead process.
- Job ownership is durable and fenced. A valid lease or credibly live owner prevents healing; an expired dead owner fails explicitly. Arbitrary PIDs are never signaled on PID evidence alone.

## Implementation

### 1. Runtime and dependency preflight

- Align the root package engine and installer/start checks on Node `>=22.12.0` without upgrading dependencies.
- Resolve the Node executable once and export it as `PI_NODE_PATH`.
- Require the server-local `apps/server/node_modules/tsx/dist/cli.mjs` and frontend-local `frontend/node_modules/.bin/vite`, with an actionable instruction to rerun `scripts/install.sh`.
- Remove pnpm/npm and their cache/store directories as runtime requirements from `scripts/start.sh`; pnpm remains required by installation, build and development commands outside the installed launcher.

### 2. Process ownership and readiness

- Start the control plane in a background subshell that changes to `apps/server` and `exec`s Node plus the server-local tsx CLI with `watch src/main.ts`.
- Start Vite in a background subshell that changes to `frontend` and `exec`s the package-local Vite shim with host `127.0.0.1`, port `5173`, and `--strictPort`.
- Track those PIDs and terminate each owned process tree with a bounded TERM grace period followed by KILL when needed. Retain the initial descendant set so TERM-ignoring children are still killed after their root exits or they are reparented. Wait only for targeted PIDs.
- Use one end-to-end configurable `PI_SCIENCE_STARTUP_TIMEOUT_SECONDS` deadline with a 90-second default across sequential control-plane and frontend readiness. Detached startup uses the same outer deadline and rolls back only the verified supervisor and its captured descendants.
- Persist detached state atomically as PID, random launch token, process-start evidence and checkout identity. Discard malformed, legacy, mismatched or PID-reused state without signaling it.
- Retain the original descendant snapshot across TERM cleanup so reparented TERM-ignoring descendants are still killed. Never sweep a pre-existing checkout-local listener.
- Do not reuse an ambiguous existing listener. If port 5173 is occupied, fail with an explicit error instead of relying only on process CWD.

### 3. PATH launcher safety

- Mark generated launchers with a stable ownership marker and the checkout path.
- Allow reinstall only when the existing launcher is a regular non-symlink file generated by Pi-Science for this checkout.
- Refuse unrelated files, directories, symlinks, and launchers owned by another checkout.
- Serialize cooperating installers with an ownership-tracked same-directory lock, revalidate immediately before commit, and hard-link the prepared same-directory file into place so a file, directory, or symlink created after validation is never overwritten. A failed contender cannot remove another writer's lock; INT/TERM exits and cleans owned state exactly once.
- Active non-cooperating hostile races in the final revalidation/unlink window of an already-owned launcher are not claimed to be fully preventable by portable Bash across macOS/Linux/Git Bash; demonstrated destination substitutions are detected and never reported as successful.
- Keep checkout and bin paths correctly quoted, including spaces.

### 4. Durable JobCoordinator ownership

- Give every coordinator a random instance ID and process-start timestamp. Every nonterminal job persists owner PID, generation, random fencing token, heartbeat timestamp and lease expiry.
- Renew leases on one bounded unref'ed interval per active job and stop it on success, failure, cancellation, timeout and shutdown.
- Perform running, heartbeat, cancellation, healing and terminal transitions under the per-job file lock. Terminal writes require the same generation/token, so cancellation or healing wins over stale output.
- Preserve a job while its lease is valid or its owner is credibly active. Existing records without ownership metadata retain the legacy grace compatibility path.
- Fail-and-reap does not adopt process streams after restart. A lost owner is recorded as failed with an explicit reason. PID reuse or unverifiable process identity is handled conservatively and is never signaled.

### 5. Tests and CI

- Add a static launcher contract test for package-local CLI paths, CWD-preserving subshells, absence of npm/pnpm runtime wrappers, Node version checks, dependency diagnostics, and the generated-launcher safety contract.
- Add a credential-free Bash lifecycle fixture that builds a temporary checkout with fake Node/tsx/Vite/Python assets and verifies readiness, preserved CWD, package-wrapper absence, foreground SIGINT and TERM cleanup, KILL fallback for a TERM-ignoring reparented descendant, detached slow/never-ready behavior, status/stop/PID cleanup, startup-failure cleanup, port release, paths containing spaces, Node-version boundaries, missing dependencies, generated-launcher execution, checkout ownership refusal, deterministic file/directory substitution races, symlink refusal, and safe reinstall of an owned launcher.
- Run launcher tests only in Ubuntu CI. Windows CI continues to validate the cross-platform application but is not evidence of native shell-launcher support.

### 6. Documentation

Update `README.md` and `README.zh-CN.md` together to state:

- Node `>=22.12.0`;
- the launcher is for a local checkout and deliberately runs watch/dev servers;
- supported shell platforms and the native Windows non-goal;
- installed starts no longer require npm/pnpm wrappers, while install/build still require pnpm;
- dependency or lockfile changes after `git pull` require rerunning `scripts/install.sh`;
- PATH launcher collision behavior and checkout-move reinstall requirement.

## Validation matrix

| Area | Validation |
| --- | --- |
| Shell syntax | `bash -n scripts/start.sh scripts/install.sh scripts/pi-science.sh` |
| Launcher contracts | Static contract test and temporary-checkout lifecycle test |
| Cleanup | Observe fake control-plane/frontend child PIDs exit and ports become bindable after TERM, foreground SIGINT, detached stop, deadline rollback, and startup failure; verify KILL removes a TERM-ignoring reparented child |
| Paths | Run lifecycle fixture from a checkout path containing spaces |
| Installer | Refuse unrelated file/directory/symlink; portable no-clobber reinstall with rollback; three-party contention and signaled-writer cleanup |
| Job ownership | Two coordinators, valid/expired leases, dead and unverifiable owners, stale-terminal fencing, legacy records and heartbeat cleanup |
| Type safety | `pnpm typecheck` |
| JS behavior | `pnpm test` |
| Build | `pnpm build` |
| Python runtime | `cd backend && uv run pytest -q` |
| Control plane | `pnpm smoke` |
| CI | Ubuntu launcher lifecycle plus existing Ubuntu/Windows quality matrix |

## Non-goals

- Production static frontend hosting or running `apps/server/dist/main.js` from this launcher.
- Native PowerShell/CMD launchers or native Windows process supervision.
- Adopting or reconnecting to a dead server's child process streams after restart; that requires a separate durable runner architecture.
- Dependency upgrades.
- Redesigning `scripts/pi-science.sh` beyond changes required to preserve the hardened start/stop contract.
- Reusing arbitrary existing frontend listeners.

## Rollback and residual risks

The source changes are isolated to shell launch/install behavior, launcher tests, CI wiring, engine metadata, and documentation. The process-launch commit and installer-safety commit can be reverted independently. `tsx watch` and Vite remain development processes and retain their own internal child-management behavior. Git Bash signal semantics can differ from WSL/Linux; documentation will not claim native Windows equivalence. Force-overwriting unrelated PATH entries is intentionally not provided; users must move/remove collisions explicitly.

## PR acceptance criteria

- `start.sh` directly owns package-local tsx and Vite processes while preserving package CWDs.
- npm/pnpm wrappers are absent from the runtime start path.
- startup failure, detached deadline expiry, TERM, and foreground SIGINT release owned listeners within a bounded interval.
- missing dependencies and unsupported Node versions fail before services start with actionable diagnostics.
- installer refuses unrelated/symlink collisions and reinstalls its own launcher with the documented portable no-clobber/rollback contract.
- detached status/stop validate exact supervisor identity and never signal an unrelated live PID.
- healthy owned jobs survive observation beyond the former 15-second boundary; expired dead owners fail explicitly and stale owners cannot overwrite the result.
- checkout paths containing spaces work.
- Node `>=22.12.0`, platform boundaries, local-dev status and reinstall rules are documented in both READMEs.
- Focused launcher tests and the repository verification commands pass.
