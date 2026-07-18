---
name: molecule-qc
description: Quality-check molecular structure files and SMILES for parseability, atom counts, valence warnings, and explicit missing or ambiguous fields.
version: 0.1.0
license: Apache-2.0
category: chemistry
requirements:
  - name: openchemlib
    kind: package
    optional: true
risk: low
---

# Molecule quality control

Identify the input representation before checking it. Preserve the original
structure, report parser warnings and stereochemistry ambiguity, and never
silently “repair” a structure without recording the transformation.

