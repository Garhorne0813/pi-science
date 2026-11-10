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

Provision the Linux dependencies described in [Universal Sandbox](../universal-sandbox.md). Supply `DEEPSEEK_API_KEY` only through the process environment, then run:

```bash
PI_SCIENCE_RESEARCH_LIVE_TEST=1 \
  pnpm --filter @pi-science/server exec vitest run \
  src/runtime/agent/auto-research.live.test.ts
```

This is a paid, network-dependent opt-in test. Per-case observations are written under ignored `.runtime/live-tests/auto-research-comparison.json`; fixture workspaces are removed on normal test completion. Incomplete cases are recorded without skipping subsequent cases; all four cases must pass the final comparison assertion. The test never changes isolation mode or supplies host execution fallback.

## Decoupling and Research Lite regression (2026-10-19)

The Skill now requires only read/write. Source-only work loads a separate short literature reference and can retain evidence criteria, citations and continuation notes in one report or the conversation. It does not require a research budget binding, evaluation.yaml or experimental manifest. A real Worker/IPC fixture runs this mode with exactly read/write and verifies a report, zero executions and no research-budget binding. This checks capability independence and transport; its prescribed model responses do not measure reasoning quality.

Experimental execution still requires the existing budget and sandbox capabilities. Role metadata `execution_scope: candidate`, assigned Candidate IDs and inherited restrictions replace Runtime checks for a specific Skill/role name. Dispatch persists the admitted restriction for recovery. Tests cover arbitrary role names, explicit tool escalation, forged scope parameters, restricted/unbound reads/Bash/Notebook, authenticated kernel grants, and recovery after role metadata is removed. Legacy Skill-local roles without scope declarations are refused at dispatch with an actionable missing-scope diagnostic; interrupted tasks without scope metadata cannot execute new children and persist a non-resumable migration failure. Already committed results remain collectible. Legacy custom roles should explicitly declare their scope. The manifest remains strict when used, but a single bounded analysis may cite results and real references directly; multi-round comparison and experimental recovery use the full index. `risk: medium` reflects optional execution/delegation and grants no permission itself.

The opt-in live comparison now withholds execution_budget from both literature modes and rejects experimental manifests/computations there. It records these separate signals in the existing JSON observations:

| Signal | Recorded evidence | Interpretation |
| --- | --- | --- |
| Cost | Tokens, tool calls, elapsed time and paired Skill/plain token/call ratios | Operational cost; compare only successful, equivalent tasks |
| Numerical correctness | Known-answer measurements, protocol incompatibility, checked Execution/Artifact links | Fixture correctness and provenance, not discovery quality |
| Literature evidence | Supplied source IDs, unexpected DOI citations, synthetic disclosure, method contrast, uncertainty and qualified causality | Fixture-specific lexical smoke checks; human review still checks entailment and unsupported claims |
| Error recovery | Injected Candidate failure followed by actual successful execution | Prescribed repair outcome, not a general recovery rate |
| Corrections | Automatic manifest repairs; human corrections left null until independently annotated | Unmeasured human intervention is not zero |

For a baseline or regression comparison, keep model/settings/task inputs fixed, run at least five paired repetitions, retain incomplete trials and report completion rate plus median/range of cost ratios. Record human corrections and claim/citation errors through independent report review; do not infer them from keyword checks. Require the fixture quality gates before interpreting any cost reduction. Set project-specific cost thresholds only after repeated baseline observations; there is no universal research quality score or hard-coded token target.

The historical cost table above is unchanged. The live API comparison has not been rerun for this change; no token reduction or improved scientific quality is claimed. The live test remains opt-in and uses the reproduction command above.


## Generic grants and research decision journal

New execution authority is a private service-issued grant of canonical roots, offline network, exact tools and task-budget/deadline identity. Candidate IDs are correlation metadata on this path. Old research directory resolution lives in an explicit Skill compatibility adapter; new Draft/Patch executions require no research scope or Candidate directory convention. sandbox_run has been removed; its historical producer and evidence remain readable through Session/Execution/Artifact records.

The Skill now appends stable-ID decisions to research-events.jsonl and rebuilds optional v1 manifests. The helper uses Node's built-in SQLite solely for crash-released writer locking; JSONL holds the research history. Tests cover process concurrency and lock-owner death, lost acknowledgements/partial batches, projection corruption/rebuild, frozen evaluated experiments, malformed committed records, preserved/recovered torn tails, link rejection and idempotent legacy import with exact-byte snapshots. A real Parent sandbox test executes the helper rather than mocking filesystem commits.

Grant regression includes arbitrary business layouts, Worker/budget binding, denied root/identity changes, protected data and raw policy injection, parent root/tool/deadline/ancestry limits, signed Notebook grants, and real watchdog termination on grant or budget revocation. A real child test verifies Candidate correlation cannot select directories, read evaluator/control data or write the Parent's decision log. Existing scientific repair, legacy executor and persistent Notebook tests remain required. No paid model cost/quality claim is added; the historical comparison table is unchanged.

Local final verification for this stage: server **1,046 passed / 58 configured skips**; real Linux grant/Worker/Notebook/legacy isolation **71 passed / 1 platform skip**; Skills **46 passed**. Workspace typecheck and production build passed; the existing frontend large-chunk warning remains. Native macOS/Windows acceptance and the paid API comparison were not run locally.

## sandbox_run retirement (2026-10-19)

The public tool registration, dedicated Python executor, operator enable switch and role capability allowance have been removed. Restricted reads now live in `confined-read-tool.ts`; generic Bash/Notebook grants and isolation remain unchanged. Old custom declarations cannot restore the removed tool. Existing Session/Execution/Artifact records preserve their original producer, source, logs and artifact versions; no historical invocation is automatically translated or replayed.

Regression coverage verifies absence through real Worker IPC even when an old Parent tool list requests sandbox_run, denial in legacy role capability intersections, and read-only reopening of historical succeeded/failed/cancelled/timed_out/lost execution records. The full server suite passed **1,042 tests / 44 configured skips**. Real Linux grant/Worker/Bash/Notebook/read acceptance passed **49 tests**; Skills passed **46 tests**. Workspace typecheck and production build passed. Retired executor tests were removed, so these counts are not directly comparable with earlier stages. Native macOS/Windows and paid API tests were not run locally.

## Review follow-up: settled abort and mixed grants (2026-10-19)

The Ubuntu quality failure on `b02a2f3e` showed an idle abort marking an already completed research operation as cancelled. The Worker previously cancelled the cached watcher identity before asking Core whether any operation remained active. Abort now cancels a budget only after Core confirms the aborted operation ID matches the identity captured for that command. It cannot cancel a stale settled watcher or a different operation. A deterministic Worker test simulates delayed watch notification; existing product tests also verify active abort cancellation and research continuation.

The P1 legacy executor escape is removed by sandbox_run retirement. Real Worker IPC acceptance now explicitly requests `sandbox + candidate_id`, declares sandbox_run in both the role and Parent list, and creates disjoint legacy Candidate directories. Both with and without a bound research budget, the child exposes only read/Bash, publishes an Execution under the generic grant and leaves legacy work untouched. The real Linux tools suite passed **26 tests**; focused Worker/product-turn tests passed **28 tests**. The full server suite passed **1,043 tests / 45 configured skips**. Server typecheck and build passed. Native Windows/macOS checks remain CI responsibilities.

## Review follow-up: confined authorization traversal (2026-10-19)

The bounded large-workspace benchmark reproduced the repeated traversal concern on `1b9b051c`: a delegated read of one small grant input with 20,000 unrelated scientific files took 1,136.85 ms p50 / 1,166.48 ms p95. Scoping current protection discovery to the actual grant roots plus sensitive ancestors reduced this fixture to 4.68 ms / 6.60 ms. Full methodology, limits and raw before/after samples are in [Confined authorization benchmark](../performance/execution-grants-benchmark.md); these local five-sample measurements are not native Windows/macOS acceptance.

No authorization data is cached across calls. Grant/config sources, ancestor revocation, budgets, directory identities, tool ceilings and current operator-protected roots remain live checks. A structural test verifies inaccessible siblings are not traversed, while regression tests cover newly sensitive descendants, sensitive root ancestors and newly configured protected roots. Confined read capture uses the policy from the locked recheck, including protection added after initial authorization.

Validation: full server **1,047 passed / 45 configured skips**; real Linux grant/Worker/Bash/Notebook/read suite **54 passed**. Server and standalone benchmark typechecks, server build and diff checks passed. The new PR commit triggers native Windows quality verification; the earlier cancelled Windows job is not treated as a passing check.

## V1 role tool inheritance and Windows verification budget (2026-10-19)

Roles now preserve three tool declaration states in discovery: omitted inherits the Parent's current eligible active tools; an explicit empty list grants none; an explicit list only narrows Parent authority. Builtin/project/Skill roles share this rule, while execution_scope migration remains independent and fail-closed. The three packaged research roles omit tool lists and provider enumeration. Workspace Researcher/Reviewer read-only instructions are task intent, not an enforcement boundary; a Parent that requires strict read-only access must narrow the per-task tools. Confined Experimenters still require a server-bound grant and the existing read/Bash/Notebook ceiling.

Admission persists the effective tool snapshot. Resume and per-call checks retain it as an upper bound even if a role becomes broader or a new Parent tool appears; interrupted tasks with no snapshot cannot reconstruct historical authority from current definitions. Tests cover omitted/empty/explicit declarations, task narrowing, durable snapshots, Parent/role revocation and live role widening. Real Worker IPC exercises a new MCP provider absent from the role file without adding a registry or bypassing MCP authorization. The final full server suite passed **1,061 tests / 45 configured skips**; the real Linux confined suite passed **54 tests**; Skill tests passed **46 tests**. Workspace typecheck/build and the final frontend build passed.

The previous native Windows verify job [117912407257](https://github.com/Garhorne0813/pi-science/actions/runs/39207165175/job/117912407257) started and was cancelled at the configured 20-minute job limit during serialized tests, without a reported failed test before cancellation. The Windows-only job limit is now 45 minutes; other verify jobs remain at 20 minutes. YAML parsing was checked locally. The larger limit permits native verification to finish but is not itself evidence of a passing Windows run.
