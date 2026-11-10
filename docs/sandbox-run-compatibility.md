# sandbox_run retirement and migration

sandbox_run is no longer registered or callable. Its dedicated Python executor, operator enable switch (`PI_SCIENCE_SANDBOX_ENABLED`) and role capability allowance have been removed. A custom role or old Parent tool list cannot restore it. Generic Sandbox isolation and execution grants remain in effect for Bash and Notebook.

For new CLI/Python scripts use Bash; for stateful Python cells use notebook_run. Update custom role declarations and Parent tool lists explicitly, retaining the existing parent intersection and confined tool ceiling. Parent dispatch must still issue an execution grant with approved read/write roots and a task budget. See [Universal Sandbox](universal-sandbox.md).

Historical Session/Execution/Artifact records remain readable with their original producer, execution IDs, code, logs and immutable artifact versions. Inspect those records through the existing record surfaces; calling the deleted tool cannot return or replay an old result. No migration rewrites historical records, automatically translates old calls, resets work directories or starts a replacement execution. An uncertain completion must be inspected before choosing a fresh Bash/Notebook invocation with a new ID.

Bash/Notebook follow their own timeout, output capture and recovery contracts. They do not inherit the removed executor's automatic invalid-work reset or its invocation replay behavior. An isolation failure still fails closed and never authorizes a host fallback. The separate read-only Candidate directory adapter remains for old Candidate-ID-only dispatch requests; it creates generic grants and does not execute sandbox_run.

Historical implementation and CI evidence remain in [implementation history](implementation/auto-research-history.md). Its old enable commands and sandbox_run examples are archival and cannot be used with the current server.
