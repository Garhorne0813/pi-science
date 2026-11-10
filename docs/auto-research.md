# Conversation-native Auto Research

Auto Research runs in the current conversation through skills/auto-research. The Skill owns scientific questions, Candidate/Experiment identities and directories, evaluation protocols and research decisions. Runtime owns authenticated execution grants, isolation, task budgets and authoritative Execution/Artifact evidence. There is no Research API, separate coordinator or fixed role pipeline.

## Progressive workflows

Source-only work loads only [literature research](../skills/auto-research/references/literature-research.md), needs no execution-budget binding or experimental index, and preserves evidence, uncertainty and continuation notes in the report/conversation.

Experimental work loads [research protocol](../skills/auto-research/references/research-protocol.md), [evaluation](../skills/auto-research/references/experimental-research.md) and [safety/recovery](../skills/auto-research/references/experiment-safety.md). Parent validates a task-specific evaluator, freezes versions and independently evaluates real candidate outputs. Reviewer PASS or process exit zero does not establish scientific validity. Parent evaluation provides methodological independence, not protection against a malicious Parent; truly confidential holdouts require operator-protected roots.

## Generic execution authority

The default Experimenter declares `execution_scope: confined`; Runtime limits inherited Parent capabilities to read/Bash/Notebook. Parent creates approved input/work directories and passes a `sandbox` selection to `subagent`. Runtime validates canonical directory identities, parent permission containment, protected paths, tool ceilings and the existing budget subtree, then stores an immutable private grant bound to the child task. All new Bash/read/Notebook paths use that grant; `candidate_id` is optional correlation metadata and never selects directories on this path. Draft/Patch/other layouts work without research IDs.

Grant records live outside workload writes and are unavailable to file tools. Signed Notebook identity carries only an opaque grant reference and authenticated task identity. Grants force required isolation and offline networking, even when ordinary Parent workspace execution is configured trusted-host. A trusted watchdog observes grant revocation, changed operator configuration, cancelled budgets and narrowed deadlines, including idle persistent kernels. Descendants cannot widen parent roots, ceilings or budget ancestry. Root aliases/links, special files and replaced directory identities fail closed.

The Parent must keep the decision log, evaluator, sibling candidates and confidential data outside child grants. Runtime checks authority, not scientific meaning: an explicit parent selection must accurately reflect approved inputs. Missing grants support text-only generation; they never authorize workspace fallback. Existing `execution_scope: candidate` and Candidate-ID-only tasks use the separate [legacy adapter](../apps/server/src/skill-adapters/legacy-auto-research.ts), which translates the old budget/directory convention into a validated grant. New generic execution does not resolve those business directories. sandbox_run has been removed. Historical Session/Execution/Artifact records retain their original producer, source, logs and artifact versions for inspection; no legacy tool invocation is resumed or replayed.

## Decision history and derived indexes

For multi-round comparisons/recovery, `research/<id>/research-events.jsonl` is the sole Skill-owned decision history. Append stable-ID events using [research-journal.mjs](../skills/auto-research/scripts/research-journal.mjs). Events create candidates, link actual Execution/Artifact references, record evaluation decisions, select a candidate and save continuation checkpoints. The helper does not execute experiments or verify platform evidence existence. Parent must verify actual records and immutable bytes before recording completion.

`manifest.json` is an optional rebuildable v1 projection, with the existing six-field format and [strict validator](../skills/auto-research/scripts/validate-manifest.mjs) for old readers. Do not independently edit it or maintain a second completed-ID ledger. Latest checkpoint/selection/head are available through `inspect`; new work does not separately edit state.json. A single bounded analysis may keep protocol/results/real references in its report without a journal.

The helper requires Node 24. SQLite is used only for an OS-released cross-process writer mutex; the lock database contains no research tables/state. Do not delete/replace it while writers are active. JSONL append is synced; the derived index uses synced atomic replacement. Stable IDs make lost-acknowledgement and partial-batch retries idempotent. Committed malformed lines stop replay. Only an unterminated final record can be recovered, with its exact bytes preserved before truncation. File aliases/hardlinks are refused. This is an ordinary Skill helper, not a Runtime research service. Lite does not load it.

Operator/developer commands (Parent may run the same helper through authorized sandboxed Bash; if Skill resources are not executable there, copy both helper scripts into an ordinary authorized directory first):

```bash
node skills/auto-research/scripts/research-journal.mjs append /workspace/research/study events.json
node skills/auto-research/scripts/research-journal.mjs inspect /workspace/research/study
node skills/auto-research/scripts/research-journal.mjs rebuild /workspace/research/study
node skills/auto-research/scripts/research-journal.mjs recover-tail /workspace/research/study
```

`events.json` can contain one event or an ordered batch. A retry uses the same IDs/content; a malformed batch is rejected before append. A crash during a batch can commit a prefix; inspect/recover its uncommitted tail, then retry the same batch. Rebuilding an index never requires rerunning scientific measurements.

## Historical migration

Existing manifests remain readable. Explicitly import before journal-based continuation:

```bash
node skills/auto-research/scripts/research-journal.mjs import /workspace/research/study
```

Import validates the manifest, preserves its exact bytes in a digest-named legacy snapshot and records one idempotent `legacy_imported` event. Protocol versions, result paths and Runtime IDs are retained; no experiments execute and old state.json is not rewritten or trusted as completion evidence. Append an explicitly reviewed checkpoint and regenerate the projection afterward. Never dual-write the old completion ledger and new history. Already indexed scientific data remains recoverable through existing validation/readers until a study is migrated.

[Scope migration](universal-sandbox.md#scope-migration-after-upgrade) describes missing-role declarations and unscoped historical tasks. [Universal Sandbox](universal-sandbox.md) covers operator/platform boundaries. [Validation history and comparison limits](implementation/auto-research-validation.md) retain historical costs; this architecture change does not claim lower paid-model usage or improved scientific quality.

Role files describe responsibilities and execution scope; they omit fixed tool/provider lists. Researcher and Reviewer inherit the Parent's currently authorized eligible tools, and new authorized MCP providers need no Skill edit. Delegation `tools` can narrow that set (`[]` means none). Workspace roles may inherit side-effectful tools: read-only prose is task intent, not a permission boundary. Parent-selected tool restrictions and normal per-call approval/revocation checks still apply. Experimenter inheritance remains bounded by the confined read/Bash/Notebook ceiling and its server-issued grant. Admitted task snapshots never widen after role edits. See [delegated tool inheritance](universal-sandbox.md#delegated-tool-inheritance).
