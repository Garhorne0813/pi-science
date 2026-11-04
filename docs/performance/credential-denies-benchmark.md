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

macOS arm64, Node v26.0.0, three samples. These measure the deny expansion only,
not total Bash latency.

| Case | Twelve glob walks p50 (ms) | Single scan p50 (ms) | Ratio |
| --- | ---: | ---: | ---: |
| Full tree, 101,002 entries | 94.84 | 36.27 | 2.61 |
| One denied subtree, 50,502 entries | 95.10 | 17.33 | 5.49 |

## What the numbers do not say

One traversal of the granted roots is the floor for exact name matching at any
depth, and the benchmark's synthetic tree is small and warm. A production home
directory with millions of entries, a cold page cache or a network filesystem
will spend most of its time inside `readdir` rather than in matching, and the
ratio above will shrink. The recorded `credential_scan_ms` and
`credential_entries` on each execution are the authoritative number for a real
deployment; a shared cross-invocation cache was rejected because it cannot
distinguish a stale result from a newly created credential file.
