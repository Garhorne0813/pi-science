---
name: band-structure-analysis
description: Inspect EIGENVAL and DOSCAR files, preserve reciprocal-path labels and energy units, and relate band or density-of-states features to explicit input metadata.
version: 0.1.0
license: Apache-2.0
category: solid-state-physics
requirements:
  - name: python
    kind: python
    optional: true
risk: low
---

# Band-structure analysis

Check file headers, spin channels, k-point ordering, and the Fermi-level
convention before plotting. Keep the raw file available as an input artifact;
a chart without a verified unit and path label is not a physical conclusion.

