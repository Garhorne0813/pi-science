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
| `packages/client/ui-sidebar/src/client/SidebarRoot.module.css` | Rail geometry (56px, 36px controls, padding 18/10), new-session button (38px, radius 12px), collapse motion 150–200ms |
| `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css` | Chat content width 748px, composer width = content + 32px, 36px fade mask, tabs 13px/2px active bar |
| `packages/client/ui-conversation/src/client/skeleton/InputBar.module.css` | Composer card: radius 22px, 1px border `rgba(0,0,0,0.10)` light / `rgba(255,255,255,0.06)` dark, send button 34px circular `#4176e6` (dark `#679efe`) |
| `packages/client/ui-conversation/src/client/chat/MessageItem.module.css` | User bubble: max-width `min(525px, 82%)`, radius 22px, padding 10px 16px |
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

## Provisional values (Pi-Science proposals, no upstream selector)

These keep our app readable without an exact upstream counterpart; a design
owner should confirm or revise them:

- Expanded sidebar default `260px` (existing value, unchanged).
- App `body` base font-size stays `15px` (existing); UI labels `13px`.
- Page title scale: `20–28px` sans, weight 500.
- Inspector default width `420px` (existing, unchanged).
- Scrollbar: thin, thumb = border color (existing pattern, kept).
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
