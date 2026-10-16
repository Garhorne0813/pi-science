# Skill-native evaluation validation

Validation date: 2026-10-16. The default workflow uses existing Conversation tools; no evaluator registry, approval, dedicated scoring tool or evaluation-specific environment variables are provisioned.

## Regression and real isolation

At feature commit `700c4f78`, workspace `pnpm typecheck`, `pnpm test` and `pnpm build` passed: contracts 14, server 945, frontend 1,778 and Skills 38 tests (2,775 total; server 42 configured skips). After the final execution-reference and session-directory fixes, server typecheck/build and the real Linux focused suite passed **72 tests / 2 configured skips**. Skills were rechecked after instruction changes. The frontend build retains its existing large-chunk warning.

The Linux suite uses actual Bubblewrap/srt, Bash, Python and persistent Notebook processes. It covers Parent evaluation in authorized research files, Candidate repair and exact input/work isolation, denied evaluator/sibling/private/credential/link access, forged request fields, protected-root denial before/after policy changes, kernel replacement, network denial, timeout/Abort/owner cleanup, stable publication bytes and continuation without duplicate executions. Historical manifest evidence and saved generic budget consumption remain readable. macOS/Windows required-mode execution remains unavailable and fails closed; native Windows regression runs in CI.

Two small generic fixes arose during acceptance: failed Bash calls now return their recorded Execution/Artifact references while still throwing, and parallel session creation shares the existing bounded retry for vanished atomic `.jsonl.tmp` files. Neither adds research-specific runtime state.

## Review follow-up

File tools now share the sandbox sensitive-name predicate, including credential-like files, hidden control paths and dependency directories. The explicit Skill-root exception permits read-only resources, not secrets within those roots. Symlink/hardlink denial remains in place.

Writes and edits use a synced temporary file in the destination directory followed by atomic rename; Linux keeps the parent directory pinned and syncs it after commit. Existing file mode bits are retained. Fault injection covers partial writes, file-sync errors, cancellation before commit, rename failure and directory-sync failure after commit. The resulting checkpoint is either the complete old version or the complete new version. A committed manifest plus stale state is recovered by rereading the manifest, not repeating experiments. A hard kill before rename may leave a hidden temporary file; it does not truncate the destination. No extra research state machine or backup ledger is introduced.

The live comparison now requires all four cases to pass. Simple source-only tasks use lightweight evidence/report checkpoints rather than empty experimental indexes. The earlier API numbers below remain the cost baseline; this review fix does not claim a measured cost improvement and does not rerun the paid API comparison.

Review-fix verification: workspace typecheck, full tests and build passed (**2,777 tests**: contracts 14, server 947, frontend 1,778, Skills 38; server 42 configured skips). Real Linux acceptance passed **74 tests / 2 configured skips**. The final file-tool fault/denial checks were rerun after strengthening untouched-secret assertions.

## Native hardlink read follow-up (2026-10-17)

Workspace read/edit snapshots now use the descriptor reader on every platform. Linux retains its pinned directory walk. macOS/Windows validate canonical parents and a regular single-link entry, match its device/inode to the opened descriptor, then enforce link count, byte limits and mutation checks before returning captured bytes. The pathname-only read fallback is removed.

Native tests without platform skips cover benign reads, read-only Skill resources, hardlink aliases to `.env` through read/write/edit, and hardlinks created during open/read. Linux also exercises the native fallback algorithm locally; that is not native macOS/Windows evidence. Dedicated early Windows/macOS CI steps run the same tests on their actual operating systems. Paid model tests are not rerun for this filesystem fix; the historical cost baseline below is unchanged.

Local verification for this follow-up: server **950 passed / 42 configured skips**; real Linux regression **77 passed / 2 configured skips**; workspace typecheck/build passed. Native platform results are reported by the dedicated CI steps. The unchanged frontend unit suite and paid API comparison were not rerun locally.

## Real API comparison

The opt-in test is `apps/server/src/runtime/agent/auto-research.live.test.ts`. It calls the official DeepSeek endpoint with `deepseek-flash` through the production Agent Worker, then checks real executions, published artifacts and manifest links. The harness does not supply evaluator scores or model tool responses. It prepares task fixtures, Candidate directories and the same production research budget for both modes; all delegation, execution, repair, Parent evaluation and evidence writing remain model actions.

Both modes receive the same detailed task instructions; plain Conversation uses a minimal project Experimenter role and the Skill mode uses its built-in role.

The numerical fixture is a bounded known-answer squared-error task with baseline prediction 0, three predictions 1/2/3 and target 3. Candidate one must fail once and repair. Version 2 changes target to 4 and must be marked incomparable. This exercises workflow and provenance, not autonomous hypothesis discovery. The literature fixture supplies two explicitly synthetic excerpts with conflicting methods/results; it tests qualified synthesis and preserved identifiers without a numerical evaluator or computation. It is not a real literature retrieval benchmark.

Token counts use Parent session usage, which already includes delegated usage; tool calls sum actual sessions. Elapsed time includes tools. No currency cost is inferred from unconfigured model pricing. These are single-run operational observations, not a statistical claim that one mode improves research quality.

Initial unassisted long prompts failed in both modes: role-name guessing, executing before binding research_id, repeated attempts to rebind an already used operation, searching for unavailable failure references, and workspace-prefixed paths inside Candidate work. Safety gates denied invalid access; missing evidence was not accepted as a score. Those trials motivated explicit role/budget/work-directory guidance and failure-reference feedback. They are excluded from controlled-run token totals; the controlled setup does not establish that free-form long prompts are reliable.

The first controlled run produced the correct numerical measurements and real CAS-backed executions in both modes, but both manifests failed structural validation (array indexes; extra root fields). Both literature cases passed. The test keeps those completion failures explicit. Guidance now spells out ID-keyed objects and the six root fields; a single review-feedback continuation may repair the manifest using file tools, with an assertion that it creates no new executions. The validator remains strict.

Final controlled run: **all four cases passed**. Both numerical cases measured losses **9 → 4 → 1 → 0**, then **1 under incomparable protocol v2**; their manifests passed without corrective continuation. Each had one prescribed exit-7 failure followed by repair. Both literature cases made zero computational executions.

| Task | Mode | Seconds | Tool calls | Tokens | Failed tool calls |
|---|---|---:|---:|---:|---:|
| numerical | Plain | 103.0 | 19 | 155,713 | 1 |
| numerical | Skill | 131.5 | 29 | 277,792 | 1 |
| literature | Plain | 37.3 | 2 | 12,615 | 0 |
| literature | Skill | 43.7 | 11 | 43,953 | 0 |

The Skill used more calls/tokens in this sample while reaching the same known-answer measurements and qualified literature conclusion. No improved scientific quality is established. Earlier failed trials are described above and excluded from these final-run totals.

## Reproduce

Provision the Linux dependencies described in [Universal Sandbox](universal-sandbox.md). Supply `DEEPSEEK_API_KEY` only through the process environment, then run:

```bash
PI_SCIENCE_RESEARCH_LIVE_TEST=1 \
  pnpm --filter @pi-science/server exec vitest run \
  src/runtime/agent/auto-research.live.test.ts
```

This is a paid, network-dependent opt-in test. Per-case observations are written under ignored `.runtime/live-tests/auto-research-comparison.json`; fixture workspaces are removed on normal test completion. Incomplete cases are recorded without skipping subsequent cases; all four cases must pass the final comparison assertion. The test never changes isolation mode or supplies host execution fallback.
