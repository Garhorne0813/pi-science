-- One immutable UTC admission day per physical model attempt/lease. Retries and
-- reclaimed leases cannot move an earlier attempt's spend to a different day.
CREATE TABLE memory_run_usage (
  lease_token TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES memory_dream_runs(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  tokens REAL NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  reserved_tokens REAL NOT NULL DEFAULT 0,
  reserved_cost_usd REAL NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX memory_usage_day ON memory_run_usage(owner_id, day);
-- Older snapshots do not contain individual attempt days. Preserve their known
-- accounting conservatively on the original start day; new attempts are separate.
INSERT INTO memory_run_usage
SELECT COALESCE(json_extract(data,'$.leaseToken'),'legacy:'||id),owner_id,id,
 (CAST(json_extract(data,'$.startedAt') AS INTEGER)/86400000)*86400000,
 COALESCE(json_extract(data,'$.tokens'),0),COALESCE(json_extract(data,'$.costUsd'),0),
 COALESCE(json_extract(data,'$.reservedTokens'),0),COALESCE(json_extract(data,'$.reservedCostUsd'),0)
FROM memory_dream_runs WHERE json_extract(data,'$.startedAt') IS NOT NULL;
INSERT INTO memory_run_usage
SELECT 'legacy-prior:'||id,owner_id,id,
 (CAST(json_extract(data,'$.startedAt') AS INTEGER)/86400000)*86400000,
 COALESCE(json_extract(data,'$.priorReservedTokens'),0),COALESCE(json_extract(data,'$.priorReservedCostUsd'),0),0,0
FROM memory_dream_runs WHERE json_extract(data,'$.startedAt') IS NOT NULL
 AND (COALESCE(json_extract(data,'$.priorReservedTokens'),0)>0 OR COALESCE(json_extract(data,'$.priorReservedCostUsd'),0)>0);
