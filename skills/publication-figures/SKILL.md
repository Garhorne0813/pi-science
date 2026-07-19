---
name: publication-figures
description: Generate publication-grade scientific figures with a validated shared palette, consistent typography, and render-time quality checks. Use whenever you create a chart, plot, or figure with matplotlib (or seaborn) in this workspace. The style applies the pi-science publication figure standard so every generated figure reads as one design system with the app's native charts.
version: 0.1.0
license: Apache-2.0
category: visualization
requirements:
  - name: python
    kind: python
  - name: matplotlib
    kind: package
    optional: true
risk: low
---

# Publication Figures

Make generated figures **publication-grade and on-system by default**. Every
figure you produce with matplotlib must use the bundled pi-science style, so a
figure in a report and a chart in the app's inspector read as one design system.

## Apply the style (always, before plotting)

The style file `pi_science.mplstyle` sits next to this SKILL.md. Load it at
the top of any figure script:

```python
import matplotlib.pyplot as plt
from pathlib import Path

# Resolve the style next to this skill's SKILL.md
STYLE = Path("skills/publication-figures/pi_science.mplstyle")
plt.style.use(str(STYLE)) if STYLE.exists() else plt.style.use("default")
```

If you cannot resolve the path, set the palette inline from the hex values below.

## The shared palette (single source of truth)

These hues match the pi-science app's native chart colors. Assign categorical
series in this **fixed order** — never a different order, never cycle the 9th hue.

| Slot | Name | Hex |
|------|------|-----|
| 1 | blue | `#2a78d6` |
| 2 | aqua | `#1baf7a` |
| 3 | yellow | `#eda100` |
| 4 | green | `#008300` |
| 5 | violet | `#4a3aa7` |
| 6 | red | `#e34948` |
| 7 | magenta | `#e87ba4` |
| 8 | orange | `#eb6834` |

**Sequential** (magnitude, one hue light → dark):
`#cde2fb` `#9ec5f4` `#6da7ec` `#3987e5` `#256abf` `#184f95` `#104281`

**Diverging**: blue ↔ neutral gray ↔ red, with a white/gray midpoint.

## Rules (from the pi-science visualization standard)

- **One y-axis.** Never two scales on one plot — use two charts side by side
  or index to a common base.
- **Categorical color = identity, assigned in slot order; sequential = one hue
  by magnitude; diverging = two hues + neutral midpoint.** Never a rainbow
  colormap.
- **Thin marks, recessive chrome:** 2px lines, ≥6pt markers, hairline y-grid
  only, no top/right spines (the style sets these).
- **Label selectively** — the endpoint or the extreme, never a number on every
  point. A legend is present for ≥2 series; a single series needs none (the
  title names it).
- **Text stays in ink** (dark), never the series color. Identity comes from
  the mark, not the text color.
- **Save clean:** `plt.savefig(path, dpi=200, bbox_inches="tight")`.

## Checklist before returning a figure

1. Style applied (palette + chrome from `pi_science.mplstyle`).
2. Series colors assigned in slot order; ≤8 series (else group into "Other").
3. Single y-axis; legend iff ≥2 series; axis labels + units present.
4. Figure is readable and non-empty when reopened at the saved resolution.
5. Saved to the workspace and referenced by path so it surfaces as an artifact.
