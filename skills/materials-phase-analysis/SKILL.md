---
name: materials-phase-analysis
description: Analyze phase-diagram JSON and related composition data, explaining convex-hull stability, phase labels, and uncertainty without inventing missing thermodynamic inputs.
version: 0.1.0
license: Apache-2.0
category: materials
requirements:
  - name: python
    kind: python
    optional: true
risk: low
---

# Materials phase analysis

Validate the composition and energy fields before interpreting a hull. Report
which points are on or above the hull, preserve units, and distinguish a
computed stability result from a phase label supplied by the input file.

