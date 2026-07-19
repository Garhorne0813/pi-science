# Visualization Standards

## Base rules
- Use `matplotlib` with `Agg` backend (no display server needed).
- Save figures with `plt.savefig("name.png", dpi=150, bbox_inches="tight")`.
- Prefer PNG for inline display; PDF or SVG for publication vector output.
- Every figure must have: labeled axes with units, a title or caption that
  states the claim, and a legend if there are ≥2 series.

## Color palette
- **Categorical** (up to 8 series, in fixed slot order):
  `#2a78d6` (blue), `#1baf7a` (aqua), `#eda100` (yellow), `#008300` (green),
  `#4a3aa7` (violet), `#e34948` (red), `#e87ba4` (magenta), `#eb6834` (orange).
- **Sequential** (magnitude, light → dark):
  `#cde2fb #9ec5f4 #6da7ec #3987e5 #256abf #184f95 #104281`.
- **Diverging**: blue ↔ white/neutral ↔ red.
- Never use rainbow/jet colormaps — they distort perception and fail in
  grayscale.
- Use colorblind-safe palettes. Test with `plt.style.use('tableau-colorblind10')`
  as a quick check.

## Chart construction
- **One y-axis** per plot. Never dual-scale — use two charts side by side or
  index to a common base.
- 2px lines, ≥6pt markers. Hairline y-grid only (no x-grid). Remove top and
  right spines by default.
- Label endpoints or extremes, not every data point.
- Text labels stay in ink (black/dark), never in the series color. Identity
  comes from the mark, not the text color.
- Axis labels include units: "Temperature (K)", "Intensity (arb. units)",
  "log₁₀(Flux / erg s⁻¹ cm⁻²)".

## Plot types by data shape
- **Trend over a continuous variable**: line plot (`plt.plot`)
- **Comparison across categories**: bar chart (`plt.bar`) — sort by value
- **Distribution of one variable**: histogram (`plt.hist`) or KDE
- **Relationship between two continuous variables**: scatter plot
  (`plt.scatter`) — add a trend line only if you state the method
- **Composition / parts of a whole**: stacked bar or area — rarely pie charts
- **Uncertainty**: error bars (`plt.errorbar`) or shaded confidence bands
  (`plt.fill_between`)

## Post-render checklist
1. Figure file saved to workspace and is non-empty.
2. All axes labeled with units; title states the claim.
3. Legend present iff ≥2 series; single series uses title to name itself.
4. Colors from the categorical palette in slot order — no rainbow.
5. The figure is readable when reopened at the saved resolution.
