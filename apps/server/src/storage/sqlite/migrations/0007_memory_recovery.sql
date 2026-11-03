-- Persist whether a physical attempt could have reached the provider. A claim
-- alone is releasable; after dispatch, unknown spend becomes an explicit estimate.
ALTER TABLE memory_run_usage ADD COLUMN state TEXT NOT NULL DEFAULT 'reserved'
  CHECK(state IN ('reserved','dispatched','settled','estimated','released'));
ALTER TABLE memory_run_usage ADD COLUMN dispatched_at INTEGER;
ALTER TABLE memory_run_usage ADD COLUMN finalized_at INTEGER;
ALTER TABLE memory_run_usage ADD COLUMN reason TEXT;
-- v6 did not record dispatch. Never assume its outstanding holds were unused.
UPDATE memory_run_usage SET state=CASE
 WHEN reserved_tokens>0 OR reserved_cost_usd>0 THEN 'dispatched' ELSE 'settled' END,
 dispatched_at=CASE WHEN reserved_tokens>0 OR reserved_cost_usd>0 THEN day END,
 reason='legacy_dispatch_unknown';
-- v5's prior-attempt aggregate also cannot distinguish measured/unknown spend.
UPDATE memory_run_usage SET state='estimated',reason='legacy_prior_usage_unknown'
 WHERE lease_token LIKE 'legacy-prior:%';
CREATE INDEX memory_usage_unsettled ON memory_run_usage(owner_id)
 WHERE state IN ('reserved','dispatched');
CREATE INDEX memory_usage_run ON memory_run_usage(run_id);
ALTER TABLE memory_dream_schedules ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_dream_schedules ADD COLUMN next_scan_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_dream_schedules ADD COLUMN diagnostic TEXT;
