---
name: stats-integrity
description: Enforce statistical analysis integrity — execute-don't-interpret boundary, fixed random seeds, preregistration plan checks, and reproducible estimation. Use whenever running regression, hypothesis tests, or reading Stata (.dta) / SPSS (.sav) data. Flags integrity risks; never certifies the analysis is sound.
version: 0.1.0
license: Apache-2.0
category: statistics
requirements:
  - name: python
    kind: python
  - name: scipy
    kind: package
    optional: true
risk: low
---

# Analysis integrity

Your job is to **run analyses and surface raw output**, and to **withhold
interpretation the design doesn't support**. The decisive risk is not a crashing
script — it is a confident, provocative misreading of a correct number.

## Execute — don't interpret

- Report the **estimate and its uncertainty** — coefficients, standard errors,
  confidence intervals, test statistics, p-values, N — exactly as the software
  produced them.
- Do **not** volunteer causal claims. Regression and correlation are
  **associational**. Say "X is associated with Y", not "X causes / drives /
  leads to / increases Y", unless the *design* (RCT, IV, DiD, RDD, panel FE
  with a credible identification strategy) supports it — and then name the
  design.
- Do not tell the user what they want to hear. If the result is null or
  ambiguous, say so plainly.
- Report **effect sizes** alongside p-values. A tiny effect with p < 0.001 is
  still tiny.

## Reproducible execution (fixed seeds + traceability)

- Any randomised step (bootstrap, permutation, train/test split, resampling,
  MCMC) **must fix a seed**: `np.random.seed(...)`, `random_state=...`, or R
  `set.seed(...)`.
- Use `np.random.seed(42)` or `random_state=42` as the default. State the seed
  value in the output.
- Every numeric claim in a report must be traceable to a **script + line +
  output** (provenance records this automatically when you write files).

## Stata / SPSS / R round-trip

Read proprietary formats with real libraries — never transcribe numbers from
memory. `.dta` and `.sav` round-trip through R (base `foreign` / `haven`) or
pandas; use a fixed seed so estimates reproduce exactly:

```r
df <- foreign::read.dta("data.dta")   # or haven::read_dta / haven::read_sav
set.seed(1)
m <- lm(y ~ x, data = df)
summary(m)                            # report coef + Std. Error verbatim
```

```python
import pandas as pd
df = pd.read_stata("data.dta")        # or pd.read_spss("data.sav")
```

Report the coefficient **and** its standard error; if you compute the same model
two ways (e.g., pandas vs R), confirm they match to the printed precision.

## Run the integrity gate

The deterministic gate ships beside this SKILL.md. Run it on the workspace (or
named files) before you report results:

```bash
python skills/stats-integrity/stats_integrity_check.py [files...]
```

It prints one ` ```review ` fenced JSON block covering:

- **stats · interpretation** — causal or provocative language over an
  association in a report.
- **stats · prereg** — a predictor or interaction the code runs that a
  preregistration plan (`preregistration.md` / `analysis_plan.*` / `prereg.*`
  in the workspace) never named — a HARKing path.
- **stats · seed** — a randomised analysis with no fixed seed.

## Reporting

Copy the ` ```review ` block as the **last thing** in your message — the app
renders it as dismissible reviewer cards. Never tell the user the analysis is
"correct", "sound", or that a relationship is causal from observational data —
the gate checks specific risks only.
## Stages — a recoverable analysis SOP

Run analysis work as stages below. Append one waypoint per stage to
`.pi-science/sop/stats-integrity/waypoints.jsonl` (schema:
`references/waypoint-schemas.md`). **Resume by reading the waypoint log**, never
from memory.

| # | Stage | Purpose | Waypoint `checkpoint` holds |
| --- | --- | --- | --- |
| 1 | `plan` | State the analysis question, the design (and whether it supports causal claims), and the preregistration file if any | design summary, prereg ref, declared predictors |
| 2 | `run` | Execute analyses with fixed seeds; record raw output verbatim | script refs, seeds, raw output refs |
| 3 | `gate` | Run `stats_integrity_check.py` and record its ```review block | gate output, flagged risks |
| 4 | `report` | Report estimates + uncertainty; never overclaim | report ref, effect sizes, wording |

**Human gate**: stage 1 (`plan`) — if the design cannot support a causal claim,
or the preregistration is missing for a confirmatory analysis, stop with
`status: "needs_confirmation"` and get explicit user sign-off before running.

**Convergence**: single pass, no retry rounds. If `run` fails, fix the script
and re-run once; then continue.

**Completion condition**: a `completed` waypoint for stage 4 whose
`checkpoint` holds the report reference and the final gate ```review block.

**Common failure modes** (record as `failed` with the matching cause):
- `seed_missing` — a randomised step has no fixed seed; stop and fix.
- `gate_harking` — the gate flags a preregistration violation; stop and get
  user confirmation before reporting.
- `format_unreadable` — .dta/.sav cannot be read; never transcribe numbers
  from memory.
