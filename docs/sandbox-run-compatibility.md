# sandbox_run compatibility and migration

New CLI/Python work uses Bash; stateful Python analysis uses Notebook. The default Experimenter exposes read, bash, notebook_read and notebook_run. sandbox_run remains a registered compatibility adapter and is permitted only when an explicit role declaration and Parent capabilities both include it. The runtime ceiling retains it for existing definitions; it is not injected into the default role. Live permission revocation still applies. Keep a legacy declaration under the normal authorized Skill/role lifecycle when continuing an old workflow; editing a managed seeded copy is not a durable configuration mechanism.

The compatibility producer, invocation IDs, code hash, source/log records and artifact versions are retained. Matching authorized historical invocations can return durable results without an installed/enabled executor. New invocations still fail closed if execution is unavailable. Reuse with a different candidate or code is refused. Identical unfinished recovery is recorded lost instead of reexecuting uncertain code; owner-aware reconciliation on a different operation is not implemented. Read old records through existing Execution/Artifact surfaces even when the current role no longer permits the tool. Never bypass current permissions to resume a revoked call.

## Remaining differences

| Property | Bash / Notebook | Legacy sandbox_run |
| --- | --- | --- |
| Execution layer | Shared pinned srt launcher/policy/artifact primitives | Same shared primitives, dedicated compatibility adapter |
| Enable | required by default; operator trusted-host does not relax Candidate isolation | Also requires PI_SCIENCE_SANDBOX_ENABLED=1, dedicated Python/root and validated Linux |
| State | Bash scripts or persistent Notebook kernel namespace | Noninteractive Python invocation |
| Timeout | Existing tool/kernel contracts, narrowed by research budget | Default 60s, maximum 120s, narrowed by research budget |
| Capture | Generic upstream Bash capture or Notebook outputs plus authorized snapshots | 64 KiB code, 64 KiB per log stream, 16 top-level regular scientific files / 8 MiB total, 4096 tree entries |
| Invalid work | Generic tools do not promise a work reset | Next call may reset all canonical Candidate work under lock; input and existing durable records/artifacts survive; limitations report the reset |
| Recovery | Existing tool/session contracts; Bash refuses an already-recorded invocation | Return matching durable result; identical uncertain invocation becomes lost, no replay |

Do not mix an active legacy invocation with Bash/Notebook on one Candidate or reinterpret legacy reset behavior as a generic guarantee. Finish/reconcile old invocations, preserve source/log/artifact references in the research manifest, then issue new Bash/Notebook invocation IDs. Do not automatically translate an admitted call, retry after an isolation failure through another tool, reset work during migration, or rewrite old producer IDs/results.

## Removal gates

This change removes sandbox_run only from the builtin default Experimenter declaration. It does not remove its public server registration or claim feature equivalence. Before removing that registration:

1. Demonstrate real Linux parity for script outputs/artifacts, repair, budgets, timeout/Abort, Worker death and detached-child cleanup across both paths; retain Notebook namespace tests separately.
2. Verify completed, failed, cancelled, timed-out and uncertain legacy invocation recovery with execution disabled, including unchanged source/log/artifact bytes and no process launch. Verify old Session transcripts and current permission checks, not only a direct adapter call.
3. Decide and test equivalent generic invalid-work handling, bounded log/source retention, output publication and exactly-once recovery semantics. Until then retain adapter-specific behavior rather than silently merging it away.
4. Migrate historical workflow declarations explicitly, validate persisted invocation/result schemas and add release/rollback coverage. Only after those gates may remaining useful recovery/evidence logic move into the shared Runtime and registration disappear.

Operator configuration and platform acceptance are maintained in [Universal Sandbox](universal-sandbox.md); historical macOS failure evidence and CI records remain in [implementation history](auto-research-history.md). Skipped tests never establish isolation or real-model scientific acceptance.
