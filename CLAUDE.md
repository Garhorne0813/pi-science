# Pi-Science — agent guide

Pi-Science is a local-first scientific AI workbench built as three processes: a **React SPA**
(`frontend/`) as the only UI; a **Node control plane** (`apps/server/`) that is the sole state
authority for sessions, jobs, research loops, settings and workspace security; and a **Python
scientific runtime** (`backend/`) restricted to kernel/notebook execution and file parsing. Each
conversation runs its own **Pi agent process** (`runtime/pi/`, fetched). Shared DTOs live in
`packages/contracts/`; builtin agent skills in `skills/`. Python holds no business state — it is a
replaceable execution service.

## Verification

```bash
pnpm typecheck                       # contracts + server + frontend
pnpm test                            # contracts + server + frontend + skills
pnpm build                           # all JS packages
pnpm test:skills                     # literature-review skill tests only
cd backend && uv run pytest -q       # Python runtime
pnpm smoke                           # control-plane smoke test
pnpm --filter frontend test:uat:conversation   # UAT scripts (also :knowledge :notebook :office)
```

Current green baseline, known build warnings, and the characterization-test inventory are recorded
in `docs/refactoring-baseline.md`. The batch plan is `docs/refactoring-plan.md`.

## Refactoring rules
- Preserve externally observable behavior unless the task explicitly requests a behavior change.
- Do not mix refactoring, dependency upgrades, formatting changes, and feature work in one change.
- Prefer small, reversible changes over repository-wide rewrites.
- Do not introduce abstractions for hypothetical future requirements.
- Inspect actual call sites before moving, renaming, or deleting code; treat reflection,
  plugin registration, configuration references, and dynamic import as potential call sites.
- Establish a passing test baseline before structural changes; add characterization tests
  first when behavior is insufficiently tested.
- Every refactoring batch must build, pass tests, and be reviewable/revertable independently.
- Before reporting success, verify every claim using command output from the current session;
  explicitly distinguish verified results, assumptions, and unresolved risks.
- Keep the repository's dense single-line style; do not reformat untouched code.
