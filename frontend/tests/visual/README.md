# Visual regression + accessibility suite

Playwright-based screenshot baselines and an axe-core gate for the Pi-Science
frontend. All fixtures are deterministic: fixed data, fixed clock, fixed
locale/timezone, animations disabled, caret hidden.

## Requirements

- A production build: `pnpm --filter frontend build` (the suite serves `dist/`).
- A system Chrome, Chromium or Edge executable (same resolution as the UAT
  scripts). Override with `CHROME_PATH` if needed.
- No Playwright browser download is needed — install with
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (the config always launches the system
  browser via `executablePath`).

## Commands

```bash
pnpm --filter frontend test:visual              # build + full visual matrix
pnpm --filter frontend test:visual:update       # rebuild baselines (review the diff!)
pnpm --filter frontend test:visual:typecheck    # typecheck specs, fixtures and the config
pnpm --filter frontend test:accessibility       # axe gate only (@accessibility tags)
```

The Playwright `webServer` block starts the fixture mock server
(`tests/visual/fixtures/mock-server.mjs`) for the duration of the run and
serves a fixed `/api/*` surface from `tests/visual/fixtures/data.mjs`
(including a keep-alive SSE stream). It never runs outside `test:visual`.
The mock server is hardened: malformed requests get 400, handler failures get
500, and it never crashes the run; SIGTERM/SIGINT shut it down cleanly so no
zombie process keeps port 4173.

## Viewport / theme matrix

`playwright.visual.config.ts` defines six projects:

| Project | Viewport | Theme |
|---|---|---|
| desktop-light | 1440×1000 | light |
| desktop-dark | 1440×1000 | dark |
| desktop-lg | 1024×768 | light |
| mobile | 375×812 | light |
| tablet | 768×1024 | light |
| wide | 1920×1080 | light |

`desktop-lg` pins the 1024px boundary where the layout switches between the
mobile full-screen inspector overlay and the desktop split pane.

Dark theme is applied through the app's own persisted setting
(`pi-science.theme` localStorage), because `colorScheme` alone does not switch
the app — the theme is user-controlled and defaults to light.

## Baseline policy

- `toHaveScreenshot` uses `maxDiffPixelRatio: 0.005`, `animations: "disabled"`
  and `caret: "hide"`.
- Baselines live in Playwright's per-spec snapshot directories,
  `tests/visual/<spec>.spec.ts-snapshots/<project>/` — one directory per
  project. Every baseline update must be reviewed: a `test:visual:update` run
  with unrelated pixel drift means the fixture is not deterministic —
  investigate before committing.
- Screenshot failures produce a diff image in `tests/visual/.artifacts/`.
- A baseline that flakes (passes once, fails on a clean re-run) must be
  deleted and rebuilt rather than kept as a false green.

## Current coverage and known skips

Covered:

- Projects page, workspace landing hero, collapsed sidebar rail. The landing
  test uses a dedicated session-free cwd (`/tmp/visual-landing`) so the route
  can never auto-navigate into a conversation; it asserts the real hero copy
  and the composer.
- Settled conversation: user bubble, bash tool card, assistant markdown
  (headings, lists, tables, blockquote, inline code), code block toolbar,
  artifact strip, no horizontal overflow at 375px.
- Inspector: the sidebar file browser is actually expanded and the fixture
  file is opened from the sidebar tree (scoped to the `<aside>`), with the
  composer present.
- axe (critical/serious only) on projects, landing, conversation and the
  settings dialog. No rule ids are exempted: the palette ships WCAG AA
  accent (light `#3964fe`, dark accent-fill `#3a6de0` for white-on-fill text,
  dark text accent `#679efe`), AA-safe status text tokens
  (`--ok-text`/`--warn-text`/`--error-text` in light, bright status colors in
  dark), AA-safe status fills (`--*-fill`) for white-on-fill buttons, muted
  text, and the markdown code block scroller is keyboard-focusable. Any
  critical/serious violation fails the run.

Intentionally not covered yet (streaming/tool-state visuals belong to the
conversation UI milestone; the SSE fixture is ready to push scripted
`text.updated` / `agent_start` / `tool.updated` events):

- Mid-stream rendering (streaming text, open code fences, running tool cards).
- Tool error states, interaction/question prompts, research-loop cards.
- Inspector maximize/mobile dialog states.

Do not fake these gaps: if a scenario cannot be made deterministic, mark it
skipped with a reason instead of asserting a screenshot that can drift.
