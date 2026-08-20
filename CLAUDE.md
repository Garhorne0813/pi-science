# Pi-Science — agent guide

Pi-Science is a local-first scientific AI workbench built around a **React SPA** (`frontend/`) and
a **Node control plane** (`apps/server/`) that is the sole state authority for sessions, jobs,
research loops, settings, workspace security, kernels, and notebooks. Each conversation runs its
own **Pi agent process** (`runtime/pi/`, fetched). Shared DTOs live in `packages/contracts/`;
builtin agent skills in `skills/`. Compute environments are managed through Micromamba revisions
and kernels are spawned directly by Node.

## Security boundary
- The main control agent must never read, write, or execute files outside the project checkout
  (`/Users/cyq/codex/pi-science`) without the user's explicit permission. This includes but is
  not limited to: `~/`, `/tmp/`, `/etc/`, other repositories, and system directories.
- When a task genuinely requires accessing a path outside the project, ask first and state the
  exact path and reason before proceeding.

## Output and preview rules
- By default, do not start HTTP servers (e.g. `python -m http.server`) or open browsers (`open`,
  `xdg-open`, `start`). When the user explicitly asks to start the project development server,
  you may start it. Never start `python -m http.server` or open a browser just to preview
  generated files. The right-side inspector panel already renders HTML, PDF, images, and
  markdown inline through the workspace file server. Return the workspace-relative file path in
  a markdown link so the user can click to open it in the panel.
- Never generate `file://` URLs. Use workspace-relative paths that the frontend can resolve
  through `/api/files/serve/`.

## Verification

```bash
pnpm typecheck                       # contracts + server + frontend
pnpm test                            # contracts + server + frontend + skills
pnpm build                           # all JS packages
pnpm test:skills                     # literature-review skill tests only
pnpm smoke                           # control-plane smoke test
pnpm --filter frontend test:uat:conversation   # UAT scripts (also :knowledge :notebook :office)
```

Current green baseline, known build warnings, and the characterization-test inventory are recorded
in `docs/refactoring-baseline.md`. The batch plan is `docs/refactoring-plan.md`.

## UI design standard
- All frontend UI changes must follow `docs/ui/deepseek-harness-reference.md`, which freezes design
  parameters (colors, radii, spacing, motion, geometry) extracted from
  `deepseek-ai/deepseek-harness` at commit `47f943859b`. Use the Tailwind semantic tokens mapped
  there instead of ad-hoc values.
- A visual value that has no entry in the reference doc must be added there first with an upstream
  file + selector citation (or recorded as a Pi-Science proposal) before it is used.

## 子任务测试分工
- 并行 worker 只运行自己改动范围的验证（相关 vitest 文件、typecheck、focused Playwright
  用例），不并行运行完整测试套件。
- 视觉回归套件（`pnpm --filter frontend test:visual`、`test:accessibility`）由视觉 worker
  独占；`frontend/tests/visual/**` 的截图 baselines 只由该 worker 删除和重建。
- 完整验证（`pnpm typecheck`、`pnpm test`、`pnpm build`、`test:bundle`、UAT）只在集成阶段
  由集成 worker 串行运行；发现失败先修复再进入下一步。
- commit 只由集成 worker 创建；并行 worker 交付改动和证据，不自行提交。

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
