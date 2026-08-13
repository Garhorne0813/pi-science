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

## Stages — a recoverable composition SOP

Run composition as the following stages. Append one waypoint per stage to
`.pi-science/sop/figure-composer/waypoints.jsonl` (schema: see
`references/waypoint-schemas.md` — same contract as literature-review and
traceability-review). **Resume by reading the waypoint log**, never from memory.

| # | Stage | Purpose | Waypoint `checkpoint` holds |
| --- | --- | --- | --- |
| 1 | `claim` | State the scientific claim and enumerate the panel artifacts that evidence it | claim text, panel file refs, panel → evidence mapping |
| 2 | `layout` | Decide panel order, aspect ratio, labels, and output dimensions | the layout plan, output dimensions |
| 3 | `compose` | Composite panels into one figure; preserve labels and input IDs | composite artifact ref, input panel IDs retained |
| 4 | `verify` | Run image verification; record pass/fail detail | verifier output, resolution used |
| 5 | `review` | Adversarial review: does the composite misrepresent any panel? | review findings, rework decision |

**Human gate**: stage 2 (`layout`) and stage 5 (`review`) require user
confirmation — end the stage with `status: "needs_confirmation"` and wait.
Never proceed past a pending gate.

**Convergence**: only rework panels that fail `verify` or `review`; never
recompose from scratch on a failed panel. Max rework rounds: **3**. If a panel
fails 3 consecutive rounds, stop and report `failed` with the verifier output —
do not ship an unverified composite.

**Completion condition**: a `completed` waypoint for stage 5 whose
`checkpoint` lists the final artifact ref, the verification result, and the
review decision.

**Common failure modes** (record as `failed` with the matching cause):
- `panel_missing` — a referenced panel artifact does not exist.
- `verify_failed` — verification rejected the composite after max rework.
- `data_misrepresentation` — composing would silently rescale or redraw a
  panel and change its data interpretation (never allowed).
