# Credential deny benchmark

Run from the repository root:

```sh
pnpm --filter @pi-science/server exec tsx scripts/benchmark-credential-denies.ts
```

The script builds a synthetic tree of 100,000 ordinary files spread across
1,003 directories and places one credential-named file in about half of them.
It then times two ways of finding those files on the same tree.

The first is the previous approach: twelve recursive glob patterns, one per
credential name, walked in sequence while sharing one directory-listing map,
which is what upstream sandbox-runtime does for `denyRead` on Linux.

The second is `expandCredentialDenies`, which walks the tree once and matches
every name in that pass. Both must return the same path set or the run fails,
so the comparison cannot drift apart.

Fixture creation is excluded and three timed samples per operation produce raw
milliseconds plus nearest-rank p50 and p95. With three observations, p95 is the
maximum sample, not a production percentile estimate. The temporary fixture is
deleted even on failure, and `CREDENTIAL_BENCH_MAX_P95_MS` opts into a ceiling.

A second case repeats the measurement with one large subtree marked as already
denied, which exercises the pruning path.

## Local results

Linux x64, Node v24.16.0, warm page cache, three samples. These measure the deny
expansion only, not total Bash latency.

| Case | Twelve glob walks p50 (ms) | Single scan p50 (ms) | Ratio |
| --- | ---: | ---: | ---: |
| Full tree, 101,002 entries | 194.73 | 112.55 | 1.73 |
| One denied subtree, 50,502 entries | 126.73 | 23.42 | 5.41 |

Raw samples: full tree `182.88 / 194.73 / 267.98` against
`84.94 / 112.55 / 180.18`; pruned subtree `124.80 / 126.73 / 191.44` against
`22.94 / 23.42 / 24.34`.

## Original report

The same script was first run by the author of the original change on macOS
arm64 with Node v26.0.0. Those numbers are kept for comparison and were not
reproduced on this machine:

| Case | Twelve glob walks p50 (ms) | Single scan p50 (ms) | Ratio |
| --- | ---: | ---: | ---: |
| Full tree, 101,002 entries | 94.84 | 36.27 | 2.61 |
| One denied subtree, 50,502 entries | 95.10 | 17.33 | 5.49 |

## What the numbers do not say

One traversal of the granted roots is the floor for exact name matching at any
depth, and the benchmark's synthetic tree is small and warm. A production home
directory with millions of entries, a cold page cache or a network filesystem
will spend most of its time inside `readdir` rather than in matching, and the
ratio above will shrink. The recorded `credential_directories` and
`credential_entries` values are the authoritative size signal for a real
deployment; a shared cross-invocation cache was rejected because it cannot
distinguish a stale result from a newly created credential file.
