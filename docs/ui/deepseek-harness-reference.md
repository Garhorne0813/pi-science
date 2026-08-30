# DeepSeek Harness — UI Style Reference (frozen)

This document freezes the upstream evidence used by the frontend UI refresh.
It exists so every visual value in the Pi-Science restyle can be traced to a
source, and so values we invent are clearly marked as our own proposals.

## Upstream source

- Repository: `https://github.com/deepseek-ai/deepseek-harness`
- Branch: `master`
- Frozen commit: `47f943859bef60e4160492346772ded9b24f765a`
- License: MIT (upstream). We copy **design parameters** (colors, radii,
  spacing, motion) — not code wholesale, and never the DeepSeek logo,
  wordmark, or product copy.
- Upstream tech: React 18, Vite, CSS Modules + a global design-token sheet
  (`packages/client/ui-theme/src/styles/design-platform.css`), light/dark
  theme via `body[data-ds-dark-theme]`. We keep Tailwind + our CSS variables
  and only adopt the parameter values.

## Evidence files (as of the frozen commit)

| Upstream file | What we read from it |
|---|---|
| `packages/client/ui-theme/src/styles/design-platform.css` | Neutral (bluish) scale, DeepSeek blue scale, alias tokens (text/border/state/specific), light+dark values |
| `packages/client/ui-theme/src/styles/base.css` | Font stack, easing curve, transition durations |
| `packages/client/ui-layout/src/client/AppFrame.module.css` | Three-column layout, inspector columns |
| `packages/client/ui-sidebar/src/client/SidebarRoot.module.css` | Rail geometry (56px, 36px controls, padding 18/10), new-session button (38px, radius 12px), collapse motion 150–200ms, expanded padding/logo row/icon buttons |
| `packages/client/ui-settings-general/src/client/SettingsRoot.module.css` | Settings modal mask/panel, 188px nav rail, nav cells, header/options geometry |
| `packages/client/ui-workspace/src/client/WorkspaceBrowser.module.css` | Sidebar session-list region: section header, search capsule, list rows, scrollbar seat, bottom fade |
| `packages/client/ui-theme/src/client/AppearanceRow.module.css` | Settings section rows (padding/gap/separator) and selector cubes |
| `packages/client/ui-theme/src/styles/scrollbar.css` | Scrollbar skin (8px thumb), l1/l2 elevation rebind, quietBars contract |
| `packages/client/ui-theme/src/styles/gradient-shadow-text.css` | Shadow lv1–3, mask blur, markdown + UI type scale |
| `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css` | Chat content width 748px, composer width = content + 32px, 36px fade mask, tabs 13px/2px active bar |
| `packages/client/ui-conversation/src/client/skeleton/InputBar.module.css` | Composer card: radius 22px, 1px border `rgba(0,0,0,0.10)` light / `rgba(255,255,255,0.06)` dark, send button 34px circular `#4176e6` (dark `#679efe`) |
| `packages/client/ui-conversation/src/client/chat/MessageItem.module.css` | User bubble: max-width `min(525px, 82%)`, radius 22px, padding 10px 16px |
| `packages/client/ui-conversation/src/client/chat/ReasoningRow.module.css` | Borderless reasoning row, title weight 400, muted summary at 14px/24px, running sweep overlay |
| `packages/client/ui-tool/src/client/tool/components/ToolRow.module.css` | Borderless tool summary row, 2px separator dot, title + tertiary summary hierarchy at 14px/24px |
| `packages/client/ui-primitives/src/markdown/CodeBlock.module.css` | Code block radius 12px, sticky banner |
| `packages/client/ui-primitives/src/markdown/MarkdownText.module.css` | Markdown spacing (16px paragraph rhythm), link color = business blue |

## Confirmed values (have a file + selector source)

### Color — light theme

| Parameter | Value | Source |
|---|---|---|
| App base background | `#ffffff` | `--dsw-alias-bg-base` → `neutral-bluish-00` |
| Sidebar fill | `#f9fafb` | `--dsw-specific-sidebar-fill` → `bluish-50` |
| Secondary surface | `#f5f6f7` | `--dsw-specific-selector` / `--dsw-alias-bg-module-platform` → `bluish-60` |
| Hover surface | `#f1f3f5` | `--dsw-specific-sidebar-nav-item-hover` / `--dsw-alias-interactive-bg-hover-solid` → `bluish-75` |
| Selected surface | `#ebeff2` | `--dsw-specific-sidebar-nav-item-active` → `bluish-100` |
| Primary text | `#0f1115` | `--dsw-alias-label-primary` → `bluish-1000` |
| Secondary text | `#61666b` | `--dsw-alias-label-secondary` → `bluish-700` |
| Tertiary text | `#81858c` | `--dsw-alias-label-tertiary` → `bluish-600` |
| Caption text | `#adb2b8` | `--dsw-alias-label-caption` → `bluish-400` |
| Accent (business blue) | `#4176e6` | `--dsw-alias-state-business-primary` → `deepseek-500` |
| Accent hover | `#679efe` | `--dsw-alias-button-info-hover` → `deepseek-400` |
| Accent soft bg | `#e4edfd` | `--dsw-alias-state-business-tertiary` → `deepseek-100` |
| User bubble bg | `#edf3fe` | `--dsw-specific-bubble` → `deepseek-50` |
| Border l1 (hairline) | `rgba(0,0,0,0.04)` | `--dsw-alias-border-l1` |
| Border l2 (default) | `rgba(0,0,0,0.10)` | `--dsw-alias-border-l2` |
| Border l4 (strong) | `rgba(0,0,0,0.16)` | `--dsw-alias-border-l4` |
| Hover overlay | `rgba(38,49,72,0.06)` | `--dsw-alias-interactive-bg-hover` |
| Success | `#22c55e` / `#4ed17e` | `state-success-primary/secondary` → green-500/400 |
| Warning | `#f59e0b` / `#f7ad31` | `state-warn-primary/secondary` → amber-500/400 |
| Error | `#ec1313` / `#f25a5a` | `state-error-primary/secondary` → red-600/400 |
| Code block bg | `#f9fafb` | `--dsw-alias-markdown-code-block` → bluish-50 |
| Inline code bg | `#ebeff2` | `--dsw-alias-markdown-inline-code` → bluish-100 |

### Color — dark theme

| Parameter | Value | Source |
|---|---|---|
| App base background | `#151517` | `bg-base` → `bluish-950` |
| Sidebar fill | `#1b1b1c` | `specific-sidebar-fill` → `bluish-900` |
| Elevated surface (composer, menus) | `#2c2c2e` | `specific-input-major` / `button-floating-fill` → `bluish-850` |
| Selected surface | `#43454a` | `sidebar-nav-item-active` → `bluish-750` |
| Hover surface | `#353638` | `interactive-bg-hover-solid` → `bluish-800` |
| Primary text | `#f9fafb` | `label-primary` → `bluish-50` |
| Secondary text | `#cfd3d6` | `label-secondary` → `bluish-300` |
| Accent | `#679efe` | `state-business-primary` → `deepseek-400` |
| Border l1 | `rgba(255,255,255,0.06)` | `border-l1` |
| Border l2 | `rgba(255,255,255,0.12)` | `border-l2` |
| Border l4 | `rgba(255,255,255,0.20)` | `border-l4` |
| Hover overlay | `rgba(255,255,255,0.08)` | `interactive-bg-hover` |
| User bubble bg | `#2c2c2e` | `specific-bubble` → `bluish-850` |
| Code block bg | `#1b1b1c` | `markdown-code-block` → `bluish-900` |

### Geometry and motion (both themes)

| Parameter | Value | Source |
|---|---|---|
| Chat content column | `748px` | `ConversationRoot.module.css` `--dsh-chat-content-width` |
| Composer card width | content + `32px` (`780px`) | `--dsh-composer-card-max-width` |
| Composer fade mask | `36px` fixed band | `.composerSeat` gradient |
| Composer card radius | `22px` | `InputBar.module.css` `.card` |
| Composer border | `1px` l2 (thin pair) | `.card` `border` |
| User bubble max width | `min(525px, 82%)` | `MessageItem.module.css` `.userStack` |
| User bubble radius / padding | `22px` / `10px 16px` | `.bubble` |
| Send button | `34px` circle, info-fill, white glyph | `InputBar.module.css` `.primary` |
| Collapsed sidebar rail | `56px` (10px side padding, 36px controls) | `SidebarRoot.module.css` rail spec |
| New session button | height `38px`, radius `12px`, l2 border | `.newSession` |
| Code block radius | `12px` | `CodeBlock.module.css` |
| Tabs | `13px/16px` text, `2px` active bar, `36px` gap | `ConversationRoot.module.css` `.tabs` |
| Sidebar collapse motion | `150–200ms` ease-in-out | `.fading` 150ms, track 200ms |
| Easing curve | `cubic-bezier(0.4, 0, 0.2, 1)` | `base.css` `--ds-ease-in-out` |
| Transition durations | fast `100ms`, normal `200ms`, slow `300ms` | `base.css` |
| Font | system UI stack (SF/Segoe/PingFang) | `base.css` `--dsw-font-family` |

### Settings panel & rows

| Parameter | Value | Source |
|---|---|---|
| Settings modal mask | `rgba(0,0,0,0.24)` light / `rgba(0,0,0,0.50)` dark + `blur(2px)` | `SettingsRoot.module.css` `.mask` → `--dsw-alias-bg-mask-1` / `--dsw-mask-blur` |
| Settings panel | `800px` wide, `min(800px, calc(100vh - 48px))` tall, radius `24px`, bg `--dsw-alias-bg-layer-2`, `800px` replaces the figma 1080×700 | `.panel` |
| Panel shadow | lv3 `0 0 1px rgba(0,0,0,.2), 0 0 4px rgba(0,0,0,.02), 0 12px 32px rgba(0,0,0,.08)` | `.panel` → `--dsw-shadow-lv3` (`gradient-shadow-text.css`) |
| Nav rail column | `188px` wide, padding `22px 12px 0` (figma pad 12/22/12/0), column gap `18px` | `.nav` |
| Nav title | `16px/24px` weight 500, pad `0 12px` | `.navTitle` |
| Nav cell | `40px` tall, radius `12px`, pad `12px 16px 9px 12px`, inner gap `8px`, `14px/22px` weight 400 | `.navCell` |
| Nav cell selected | fill bluish-100 `#EBEFF2` (dark bluish-750 `#43454A`) | `.navCell.active` → `--dsw-specific-sidebar-nav-item-active` |
| Nav cell hover | fill bluish-75 `#F1F3F5` (dark bluish-850 `#353638`) | `.navCell:hover` → `--dsw-specific-sidebar-nav-item-hover` |
| Nav cell list gap | `4px` | `.navList` |
| Content header | `54px` tall, pad `20px 14px 8px 10px` (figma pad 10/20/14/8), close right | `.header` |
| Close button | `28×28` circle (radius `28px`) | `.close` |
| Options area | pad `0 24px 24px`, scrolls inside the panel | `.options` |
| Settings trigger (sidebar) | `34px` tall row, radius `12px`, pad `6px 10px 6px 2px`; rail variant `36×36` circle | `.trigger` / `.trigger.rail` |
| Setting row group | pad `16px 0`, column gap `8px`, hairline `border-bottom` l2 (stripped on last row) | `AppearanceRow.module.css` `.group` |
| Row title | `14px/22px` weight 400 | `.title` |
| Selector cube | `flex 1 1 180px`, pad `20px 32px`, gap `4px`, radius `16px`, `14px/22px` | `.themeCube` |
| Selected cube | fill bluish-60 `#F5F6F7` (dark bluish-800 `#353638`), border bluish-400 `#ADB2B8` | `.selected` → `--dsw-alias-bg-module-platform` / `--dsw-static-neutral-bluish-400` |

### Sidebar & session list (rail)

| Parameter | Value | Source |
|---|---|---|
| Sidebar padding | `12px` inline / `6px` vertical (`--dsh-sidebar-inline-padding: 12px`), text `14px` | `SidebarRoot.module.css` `.root` |
| Collapsed rail | `56px` wide, pad `18px 10px 6px`, `36×36` icon controls, `12px` vertical rhythm | `.root.collapsed` (figma rail spec) |
| Logo row | `60px` tall, pad `8px 4px 8px 0`, gap `8px`, mb `8px`; collapsed `36px`/mb `12px` | `.logoRow` / `.collapsed .logoRow` |
| Sidebar icon button | `28×28` circle, hover = interactive-bg-hover | `.iconButton` |
| New session button | `38px` tall, pad `8px 16px`, radius `12px`, `1px` l2 border, elevated fill, `14px/22px` weight 500 | `.newSession` |
| Session-list header | `36px` tall, radius `12px`, pad-left `4px`, gap `4px`, tertiary ink, mb `4px` | `WorkspaceBrowser.module.css` `.sectionHeader` |
| Search capsule (idle) | `28×28` circle | `.search` |
| Search capsule (expanded) | `30px` tall, radius `10px`, `1px` l2 border | `.searchExpanded` |
| Search input | `13px/18px` | `.searchInput` |
| Clear button | `24×24` circle | `.clearButton` |
| List row rhythm | `2px` between rows | `.flatList > * + *` |
| Workspace group gap | `4px` | `.groupSection + .groupSection` |
| List scroll seat | `scrollbar-gutter: stable`, `8px` bar, `2px` offset, right pad = inset(12) − bar(8) − offset(2), bottom pad `16px` | `.list` |
| Bottom fade | `24px` gradient to sidebar fill | `.fade` |
| List seat bleed | `-4px` left / `-(inset)` right so the bar sits at the sidebar edge | `.listArea` / `.regionArea` |

### Overlays, scrollbar, drag handles, type

| Parameter | Value | Source |
|---|---|---|
| Scrollbar | `8px` thumb; l1 pair on base surfaces, l2 on elevated (rebind `--dsh-scrollbar-thumb{,-hover}`); `quietBars` = transparent thumb, reservation kept | `scrollbar.css` |
| Column drag handle | `8px` hit strip centered on the column border (`margin-left: -4px`); no visible chrome for the sidebar edge | `AppFrame.module.css` `.handle` |
| Details resize pill | `12×32`, radius `10px`, floating fill, revealed on column hover/drag | `.handle[data-side='details']::after` |
| Column borders | sidebar right `1px` l1; details left `1px` l2 (dropped when collapsed) | `.sidebarCol` / `.detailsCol` |
| Frame collapse motion | grid tracks `300ms` curve `0.4,0,0.2,1`; transitions pause while dragging | `.frame` |
| UI type scale | `11/14`, `12/18`, `13/20`, `14/22`, `16/24`, `16/28`(500), `20/28`(500), `24/32`(600); markdown base `16/28` | `gradient-shadow-text.css` `--dsw-font-*` |

## Design rules to follow (设计规范)

Every future frontend UI change must follow this reference:

- Use the existing Tailwind semantic tokens (`frontend/tailwind.config.js` +
  `frontend/src/index.css`) and the migration mapping above — no ad-hoc
  hex/rgb/spacing/motion values.
- Geometry from the confirmed tables: radius scale `8/10/12/16/22`; borders
  l1 hairline / l2 default / l4 strong; session-row rhythm `2px`; new-session
  button `38px`/r12; nav cell `40px`/r12; settings panel `r24`; selector cube
  `flex 1 1 180px`/r16.
- Motion: curve `cubic-bezier(0.4, 0, 0.2, 1)` with `100/200/300ms`
  durations; honor `prefers-reduced-motion`.
- Scrollbars: `8px`-width themed thumb; elevated surfaces rebind the l2 pair;
  keep `scrollbar-gutter: stable` so revealing the bar never reflows rows.
- Type: reuse the `ui-micro/meta/caption/label/body/title` tokens instead of
  fresh font sizes; upstream equivalents are in the type-scale row above.
- Any visual value not listed here must be added to this document with an
  upstream file + selector citation before it ships, or recorded under
  "Provisional values" as an explicit Pi-Science proposal.

## Provisional values (Pi-Science proposals, no upstream selector)

These keep our app readable without an exact upstream counterpart; a design
owner should confirm or revise them:

- Expanded sidebar default `260px` (existing value, unchanged).
- App `body` base font-size stays `15px` (existing); UI labels `13px`.
- Page title scale: `20–28px` sans, weight 500.
- Inspector default width `420px` (existing, unchanged).
- Scrollbar: upstream spec confirms an `8px` thumb and stable gutter; the
  existing thin border-color thumb stays as the Pi-Science implementation and
  should align to `8px`.
- Focus ring: `2px` accent at `38%` alpha (existing pattern, kept).
- Motion tokens mapped to upstream curve: fast `100ms`, normal `200ms`,
  slow `300ms`.
- Card radius token moves `14px → 12px` to match upstream code-block radius.
- Chart grid/axis colors move from warm neutrals to the bluish scale.

## Migration mapping (upstream → Pi-Science token)

| Upstream | Pi-Science CSS var |
|---|---|
| `bg-base` | `--bg` |
| `specific-sidebar-fill` | `--sidebar` |
| `bluish-60` | `--surface-2` |
| `bluish-75` | `--surface-hover`, `--surface-inset` |
| `bluish-100` | `--surface-selected` |
| `input-major` / `button-floating-fill` | `--surface-raised` |
| `label-primary` | `--text` |
| `label-secondary` | `--muted` |
| `state-business-primary` | `--accent`, `--link` |
| `state-business-tertiary` | `--accent-soft` |
| `deepseek-300` | `--accent-border` |
| `border-l1/l2/l4` | `--border-faint` / `--border` / `--border-strong` |
| `specific-bubble` | `--bubble` |
| `state-success/warn/error-*` | `--ok` / `--warn` / `--error` |
| `--dsh-chat-content-width` | `--conversation-content-width` |
| `--dsh-composer-card-max-width` | `--conversation-composer-width` |
| `.composerSeat` 36px band | `--composer-fade-height` |
| rail 56px | `--sidebar-collapsed-width` |
| `--ds-ease-in-out` | `--ease-standard` |
| `--ds-transition-duration(-fast/-slow)` | `--motion-normal` / `--motion-fast` / `--motion-slow` |

## Brand and licensing boundaries

- Do not copy the DeepSeek name, whale logo, wordmark, favicon, or product
  strings into Pi-Science.
- Do not copy upstream source files wholesale; only parameter values and
  interaction patterns (collapse motion, sticky code banner) are in scope.
- Pi-Science keeps its own product name and "Pi" identity.

## Progress pattern proposal

The progress-pattern layer uses bundled MIT-licensed primitives from
[Generative Loaders](https://generativeloaders.com/docs) v0.1.1. It exposes only
allowlisted variants through `ProgressPatternCatalog.ts`; remote pages and
runtime CDN assets are never loaded. AICSS free components remain a visual
reference for agent states and may be copied only under its MIT terms; licensed
AICSS components are excluded until a commercial license is recorded. The public
AICSS React package is vendored at commit `4556a918fd8c9358d42d2b24a3866301b8ea10a2`
under `frontend/src/components/progress/aicss/`; Activity uses the MIT-licensed
`packages/react/src/orbs/Orb.tsx` component and its CSS module. Website-only and
Pro components are not copied.

The imported loader stylesheet owns only the internal animation geometry. The
application owns layout, semantic colors, typography, radii, accessibility
labels, reduced-motion behavior, and the settings contract. Current Activity
keeps its narrative text outside the loader so the animation cannot replace
meaning or affect Markdown and KaTeX rendering.

### Semantic Activity mapping

`aicss-auto` is the default pattern for Thinking, Current Activity, and Waiting.
The turn lifecycle controls whether progress is running, waiting, completed, or
failed. The narrative state independently selects the AICSS Orb geometry:

| Narrative state | Orb | Meaning |
| --- | --- | --- |
| orient | S1 | Understand the request |
| explore | S4 | Read or search local context |
| research | B2 | Search external sources |
| analyze | C4 | Analyze information |
| implementation | B4 | Edit or solve |
| compute | G1 | Run scientific computation |
| verify | C5 | Test, build, or validate |
| generate | B3 | Generate images or other outputs |
| interaction | C2 | Wait for user input |
| recover | G4 | Reconnect or restore state |
| complete | S5 | Finalize the turn |

A user-selected fixed pattern overrides this automatic mapping. Recoverable tool
errors remain in Execution Trace and do not change the lifecycle to failed.

### Activity row proposal

DeepSeek Harness renders reasoning and tool progress as quiet, borderless rows.
Its `ReasoningRow.module.css` and `ToolRow.module.css` use a 400-weight title and
a tertiary summary at 14px/24px, with no surrounding card border. Pi-Science
uses the same borderless hierarchy, adapted to two vertical lines so long task
names remain readable:

- primary Activity title: 14px/20px, regular weight, primary text;
- current task detail: 12px/18px, regular weight, tertiary text;
- row padding: 4px vertical, no outer background or border;
- expanded Execution Trace may keep its own quiet inset surface;
- semantic progress glyph: 20px and `--accent` in both light and dark themes.

The 12px secondary line is a Pi-Science proposal. The upstream row keeps both
fragments at 14px/24px on one line; the smaller second line preserves the same
visual hierarchy after changing to a stacked layout.
