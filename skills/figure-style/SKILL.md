---
name: figure-style
description: Create publication-ready scientific figures with data fidelity, legible labels, reproducible styling, and render-time quality checks.
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

# Figure style

Before drawing a figure, identify the claim, the data columns that support it, the unit, and the intended comparison. Choose a chart type that matches the data shape. Use explicit axis labels, outward ticks, restrained legends, colorblind-safe colors, and a reproducible output size and DPI.

After saving, reopen the image and verify it is readable, non-empty, correctly labeled, and not clipped. A figure is not verified when its title or caption makes a directional claim that the underlying data does not support.

