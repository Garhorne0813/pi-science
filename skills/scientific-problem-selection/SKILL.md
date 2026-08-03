---
name: scientific-problem-selection
description: Guide scientists through structured research problem selection — pitch new ideas, troubleshoot stuck projects, or make strategic research decisions. Use when the user wants to choose what to work on, evaluate project feasibility, define success metrics, weigh risks, or get systematic decision support for a research direction. Provides a conversational framework with four evaluation lenses (intuition, risk, optimization, parameters) and a decision-tree walkthrough; never invents field knowledge the user has not provided.
version: 0.1.0
license: Apache-2.0
category: research
requirements: []
risk: low
third_party:
  - kind: other
    name: Problem choice and decision trees in science and engineering (Fischbach & Walsh, Cell 2024)
    provider: Cell Press
    license: publisher-copyright
    info_url: https://doi.org/10.1016/j.cell.2024.09.024
  - kind: other
    name: anthropics/life-sciences scientific-problem-selection (Apache-2.0, concept reference)
    provider: Anthropic
    license: Apache-2.0
    info_url: https://github.com/anthropics/life-sciences
---

# Scientific problem selection

A conversational framework for systematic research problem selection. The
method is adapted from the decision-tree approach described by Fischbach &
Walsh (Cell, 2024); this skill re-implements the workflow for pi-science,
inspired by the Apache-2.0 skill in anthropics/life-sciences.

The frame: a good research problem is **important, falsifiable, and tractable
with the resources at hand**. Everything below exists to pressure-test those
three properties without steering the user toward a particular field.

## Entry points

Start by asking which of three situations the user is in:

1. **Pitch an idea for a new project** — work the idea up together.
2. **Share a problem in a current project** — troubleshoot what is stuck.
3. **Ask a strategic question** — navigate the decision tree.

Match the conversation to the chosen entry point. Keep a collaborative tone;
do not lecture. Return a one-paragraph summary of the idea (demonstrating
understanding and naming the general research area) before diving into the
evaluation lenses.

## The four evaluation lenses

Apply the lenses in order. Each lens ends with a concrete output the user can
take away; record every output in the response so the session has a decision
trail.

### 1. Intuition pumps — refine the idea

Rephrase the idea from a few angles to expose its kernel:

- What is the minimal version of the claim?
- What would a skeptic say is the obvious flaw?
- If it works, why is it a big deal — who benefits and how?
- What is the simplest experiment that would change your mind?

Output: a one-sentence **minimal claim** and the **change-your-mind
experiment**.

### 2. Risk assessment — identify what can kill the project

Classify risks by where they bite:

- **Feasibility risks** — can the data or methods be obtained at all?
- **Validity risks** — could the result be an artifact of the measurement?
- **Impact risks** — is the payoff real even if everything works?
- **Resource risks** — time, compute, samples, collaborators.

For each risk, state severity (high/medium/low) and a **de-risk step** that
reduces it. Output: a risk table with severity + de-risk step per row.

### 3. Optimization function — define success

Ask: what is the single quantity this project optimizes, and what is the
stopping rule? Make it measurable:

- Primary metric (e.g. effect size, accuracy, throughput, novelty score).
- Baseline to beat (published result, current method, or your own pilot).
- Minimum meaningful improvement.
- Stop condition (when to walk away).

Output: a one-line **objective function** with baseline and stop condition.
Refuse to proceed on "interesting" without a metric: ask for the smallest
measurable version first.

### 4. Parameter strategy — fix vs. flexible

Decide what is held fixed and what is free:

- **Fixed parameters** — constants of the study (system, dataset, endpoint)
  that changing would invalidate comparisons.
- **Flexible parameters** — knobs to tune (thresholds, hyperparameters,
  analysis variants) that should be explored systematically, one at a time.

Output: a two-column list (fixed / flexible) and, for flexible parameters,
the order in which to explore them.

## Decision-tree walkthrough (strategic questions)

When the user asks a strategic question, walk the tree explicitly:

1. State the decision and the options (2-4, no more).
2. For each option, apply the four lenses at low resolution.
3. Ask the tiebreaker questions:
   - Which option has the higher ceiling if everything works?
   - Which option still yields a publishable/useful result if the central
     hypothesis fails?
   - Which option best uses the resources you already have?
4. Give a **recommendation with reasons**, then hand the decision back.

Never pretend to know field-specific facts the user has not supplied. If the
decision depends on data the user has not shared, ask for it or mark the
decision as conditional.

## Output conventions

End every interaction with a structured block:

```text
MINIMAL CLAIM: <one sentence>
CHANGE-MY-MIND EXPERIMENT: <one sentence>
RISKS: <high/medium/low list with de-risk steps>
OBJECTIVE: <metric> | baseline <value> | min improvement <value> | stop <condition>
FIXED: <list>  FLEXIBLE: <list, exploration order>
```

If the conversation is still in the ideation phase, mark unfinished fields as
`(pending)` rather than inventing values.
