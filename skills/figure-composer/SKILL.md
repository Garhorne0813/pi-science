---
name: figure-composer
description: Compose a multi-panel scientific figure from existing panel images, preserve panel labels and layout metadata, and run the artifact verifier after export.
version: 0.1.0
license: Apache-2.0
category: visualization
requirements:
  - name: python
    kind: python
    optional: true
required_tools: []
risk: low
---

# Figure composer

Start from a claim and a list of panel artifacts. Define the panel order,
aspect ratio, labels, and output dimensions before composing. Do not redraw or
silently rescale a panel in a way that changes its data interpretation. Export
the composite as a new artifact, retain the panel input IDs, and run image
verification before calling it publication-ready.

