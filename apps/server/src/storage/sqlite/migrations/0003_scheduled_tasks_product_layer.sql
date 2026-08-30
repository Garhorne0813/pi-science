ALTER TABLE scheduled_tasks ADD COLUMN display_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(display_json));
ALTER TABLE scheduled_tasks ADD COLUMN origin_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(origin_json));
ALTER TABLE scheduled_tasks ADD COLUMN delivery_policy TEXT NOT NULL DEFAULT 'only_when_relevant'
  CHECK (delivery_policy IN ('always', 'only_when_relevant', 'only_on_change', 'only_on_failure'));

ALTER TABLE scheduled_task_runs ADD COLUMN outcome TEXT
  CHECK (outcome IS NULL OR outcome IN ('new_information', 'no_change', 'threshold_triggered', 'completed', 'needs_attention'));
ALTER TABLE scheduled_task_runs ADD COLUMN summary_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(summary_json));
ALTER TABLE scheduled_task_runs ADD COLUMN delivery_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(delivery_json));
