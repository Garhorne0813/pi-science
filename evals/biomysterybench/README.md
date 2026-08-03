# BioMysteryBench evaluation harness (local, offline-capable)

Offline-first evaluation harness for Anthropic's
[BioMysteryBench-preview](https://huggingface.co/datasets/Anthropic/BioMysteryBench-preview)
(5-problem preview). It downloads the pinned dataset revision once, runs model
inference against any OpenAI-compatible endpoint, records full provenance per
sample, and produces a human scoring template plus optional deterministic
include-match verdicts.

## License and usage terms (read this first)

- Dataset license: **cc-by-4.0** with Anthropic's **evaluation-and-benchmarking-only**
  terms (see `manifest.json`): benchmark content (problem statements, answer
  rubrics, task formulation) may be used to construct evaluation prompts at
  inference time and to publish benchmark results **with attribution to
  Anthropic**; it must **not** be used to train, fine-tune, reinforce, or
  distill any model.
- The repository-local fixtures (`fixtures/sample_questions.json`) are
  **synthetic contract samples** written by us — they are not derived from the
  benchmark.
- Downloaded dataset files live in `.cache/` (git-ignored); run records live
  in `runs/` (git-ignored).

## Usage

### 1. Fetch the dataset (once, requires network)

```bash
cd evals/biomysterybench
uv run python fetch_dataset.py            # downloads to .cache/, verifies sha256
uv run python fetch_dataset.py --offline  # reuse existing cache without network
```

Files are verified against the pinned sha256 values in `manifest.json`;
mismatches abort the fetch.

### 2. Run an evaluation

```bash
# Real run against an OpenAI-compatible endpoint:
PI_EVAL_BASE_URL=https://api.example.com/v1 \
PI_EVAL_API_KEY=sk-... \
uv run python run_eval.py --model claude-sonnet-4-5 --limit 5

# Offline smoke (synthetic fixtures, deterministic fake model, no network):
uv run python run_eval.py --smoke
```

Output: `runs/<timestamp>/record.jsonl` (one JSON record per sample: prompt,
seed, timestamps, token usage, estimated cost, response + sha256) and
`meta.json`.

### 3. Score

```bash
uv run python score.py --run runs/<timestamp>
# optional deterministic verdicts:
uv run python score.py --run runs/<timestamp> --answers answers.json
```

`answers.json` shape: `{"<sample_id>": ["accepted", "fragments"]}`.
`score.md` is the human scoring template (benchmark rubrics require human
judgment); `score.json` carries statuses and auto verdicts.

### pnpm shortcut

From the repo root (pnpm appends extra args directly — no `--` separator needed):

```bash
pnpm run eval:biomysterybench --smoke
pnpm run eval:biomysterybench --limit 5 --model claude-sonnet-4-5
```

## CI

The offline harness test suite runs in CI via a dedicated step
(`uv run --directory evals/biomysterybench --extra dev pytest -q`, synthetic fixtures +
fake model, no network). The real dataset and model endpoints are opt-in
developer workflows only.

## Recording provenance

Each record captures: sample id, model id, full prompt, seed, start/finish
timestamps, token usage, estimated cost (list-price table in `bmb/llm.py`;
`null` when the model is not in the table), response text and its sha256.
The run directory also stores `meta.json` (model, seed, smoke flag, dataset
problem count). Dataset files themselves are pinned by revision + sha256 in
`manifest.json`; observed hashes are written to `.cache/fetch-manifest.json`.
