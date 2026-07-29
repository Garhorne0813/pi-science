# Windows compatibility and bug audit

## Scope and method

This pass inspected the Node control plane, React/UAT tooling, Python runtime, package scripts, and CI for path containment, home/PATH handling, executable discovery, process trees, virtual environments, symlinks, and POSIX-only assumptions. Fixes are limited to reproducible or source-provable defects that do not require a product or architecture change.

## Findings fixed

| Area | Defect | Fix / regression evidence |
|---|---|---|
| Workspace security | Node rejected valid managed children/files whose names begin with `..` (for example `..results`) because containment used a raw `startsWith("..")` check. | Shared `pathIsInside` boundary check; Node/Python parity tests cover `..results`. |
| Workspace security | A missing target below a symlinked directory could pass Node's lexical check and later write outside the workspace. | Missing paths now canonicalize the nearest existing ancestors; regression test rejects `escape/future.txt`. |
| Workspace security | A symlink configured as `PI_SCIENCE_WORKSPACES` rejected its own unmarked children. | Existing managed roots are canonicalized in Node and Python; mirrored tests now accept the child. |
| Windows home paths | Catalog/config defaults and `~/` expansion used only `HOME`, which is not guaranteed on Windows. | Central `userHome` fallback uses `HOME`, then `USERPROFILE`, then `os.homedir()`. |
| Windows executables | Tool discovery only tried the bare name and `.exe`, ignored `PATHEXT`, quoted PATH entries, and PATH key casing. | Cross-platform executable lookup covers `PATHEXT`, quoted entries, and `PATH`/`Path`/`path`. |
| Windows environment provisioning | Workspace venv creation defaulted to `python3`, which is commonly absent on Windows. | Default is `python` on Windows while preserving explicit overrides. |
| Windows kernel PATH | Python kernels added `<npm-prefix>/bin`; npm global shims live at `<npm-prefix>` on Windows. | Platform-specific npm executable directory with a unit test. |
| Windows process lifecycle | Cancelling a job killed only the immediate process, leaving descendants alive and pipes open. | Windows uses `taskkill /T /F`; the lifecycle test now uses a cross-platform Node grandchild. |
| Windows Pi runtime launch | Deriving the repository root from `new URL(import.meta.url).pathname` duplicated the drive prefix (`D:\\D:\\...`) and prevented builtin skills from being seeded. | Convert the module URL with `fileURLToPath`; the native Windows CI run exercises the session/runtime tests. |
| Windows research loops | Candidate execution assumed `bash` was directly on PATH. | Resolver supports `PI_SCIENCE_BASH_PATH`, PATH/PATHEXT, and standard Git for Windows locations, with an actionable missing-bash error. |
| Windows UAT | All browser UAT scripts hard-coded the macOS Google Chrome path. | Shared discovery supports Chrome/Chromium/Edge on macOS, Linux, and Windows and validates `CHROME_PATH`. |
| Cross-platform tests/CI | One test split PATH on `:` and CI never ran on Windows. | Test uses `path.delimiter`; quality CI now runs typecheck, JS tests/build, and pytest on Ubuntu and Windows. POSIX smoke remains Ubuntu-only. |
| Workspace deletion | Deletion used separator-sensitive string prefix logic instead of a path boundary check. | Uses the same relative-path containment helper as rename/demo/skill validation. |

## Validation matrix

| Check | Local evidence | Windows evidence |
|---|---|---|
| Contracts/server/frontend typecheck | `pnpm typecheck` | Added `windows-latest` CI job |
| JS unit/integration tests | `pnpm test` plus new platform/security/browser tests | Added `windows-latest` CI job; Windows-specific behavior is also covered with platform-parameterized tests/mocks |
| JS production build | `pnpm build` | Added `windows-latest` CI job |
| Python runtime | `cd backend && uv run pytest -q` | Added `windows-latest` CI job; npm-bin and workspace parity regression tests included |
| Control-plane smoke | `pnpm smoke` on macOS/Linux shell environment | Deferred: current smoke harness is Bash/curl-oriented and remains Ubuntu-only |
| Browser UAT | Existing UAT commands when frontend/control plane are running | Browser path discovery is unit-tested; a live Windows browser run depends on the Windows CI/host having the services and browser available |

## Deferred risks and non-goals

- Installation/start/stop/smoke scripts are Bash programs. A native PowerShell installer and service supervisor would be a separate user-facing delivery project, not a safe bug-fix-only change.
- Research candidate contracts still intentionally produce `solve.sh`; Windows therefore requires Git for Windows/MSYS bash or `PI_SCIENCE_BASH_PATH`. Supporting PowerShell/Python entrypoint contracts requires an approved cross-platform research execution design.
- POSIX process groups provide graceful-then-force semantics; Windows `taskkill /T /F` is necessarily forceful.
- This environment is macOS, so real Windows execution is delegated to the new `windows-latest` CI leg. Platform-specific unit tests exercise Windows path/executable decisions locally but do not replace a native run.
- Shell-based smoke/UAT services, SSH tooling availability, Windows symlink privileges, path case-folding, and long-path policy remain areas to observe in the first Windows CI run.
