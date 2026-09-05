ALTER TABLE mcp_connectors ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1));
ALTER TABLE mcp_connectors ADD COLUMN include_tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(include_tools_json));
ALTER TABLE mcp_connectors ADD COLUMN exclude_tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exclude_tools_json));
ALTER TABLE mcp_connectors ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'ask' CHECK (approval_mode IN ('ask', 'custom', 'allow_all'));
ALTER TABLE mcp_connectors ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 1;

-- A project binding cannot be collapsed into one global setting without a
-- policy choice. Preserve evidence of every lossy conflict and fail closed
-- for the affected connector instead of silently selecting the latest project.
CREATE TABLE mcp_scope_migration_conflicts (
  connector_id TEXT NOT NULL,
  conflict_kind TEXT NOT NULL CHECK (conflict_kind IN ('enabled', 'include_tools', 'exclude_tools', 'approval_mode', 'tool_grant')),
  tool_name TEXT NOT NULL DEFAULT '',
  project_ids_json TEXT NOT NULL CHECK (json_valid(project_ids_json)),
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (connector_id, conflict_kind, tool_name),
  FOREIGN KEY (connector_id) REFERENCES mcp_connectors(connector_id) ON DELETE CASCADE
) STRICT;

INSERT INTO mcp_scope_migration_conflicts (connector_id, conflict_kind, project_ids_json, details, created_at)
SELECT b.connector_id, 'enabled', json_group_array(b.project_id),
       'Project enablement differed; connector disabled until a global choice is made',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM mcp_project_bindings b
GROUP BY b.connector_id
HAVING COUNT(DISTINCT b.enabled) > 1;

INSERT INTO mcp_scope_migration_conflicts (connector_id, conflict_kind, project_ids_json, details, created_at)
SELECT b.connector_id, 'include_tools', json_group_array(b.project_id),
       'Project include-tool filters differed; filters reset until a global choice is made',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM mcp_project_bindings b
GROUP BY b.connector_id
HAVING COUNT(DISTINCT b.include_tools_json) > 1;

INSERT INTO mcp_scope_migration_conflicts (connector_id, conflict_kind, project_ids_json, details, created_at)
SELECT b.connector_id, 'exclude_tools', json_group_array(b.project_id),
       'Project exclude-tool filters differed; filters reset until a global choice is made',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM mcp_project_bindings b
GROUP BY b.connector_id
HAVING COUNT(DISTINCT b.exclude_tools_json) > 1;

INSERT INTO mcp_scope_migration_conflicts (connector_id, conflict_kind, project_ids_json, details, created_at)
SELECT b.connector_id, 'approval_mode', json_group_array(b.project_id),
       'Project approval modes differed; approval reset to ask until a global choice is made',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM mcp_project_bindings b
GROUP BY b.connector_id
HAVING COUNT(DISTINCT b.approval_mode) > 1;

INSERT INTO mcp_scope_migration_conflicts (connector_id, conflict_kind, tool_name, project_ids_json, details, created_at)
SELECT g.connector_id, 'tool_grant', g.tool_name, json_group_array(g.project_id),
       'Project tool grants differed; effective grant reset to ask until reviewed',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM mcp_tool_grants g
GROUP BY g.connector_id, g.tool_name
HAVING COUNT(DISTINCT g.decision) > 1;

-- Preserve unambiguous values. Any conflicting connector-level binding is
-- disabled and reset to the least-privileged settings; tool-only conflicts
-- are retained as an explicit global ask below.
UPDATE mcp_connectors
SET enabled = CASE
      WHEN EXISTS (
        SELECT 1 FROM mcp_scope_migration_conflicts c
        WHERE c.connector_id = mcp_connectors.connector_id
          AND c.conflict_kind IN ('enabled', 'include_tools', 'exclude_tools', 'approval_mode')
      ) THEN 0
      WHEN EXISTS (
        SELECT 1 FROM mcp_project_bindings b
        WHERE b.connector_id = mcp_connectors.connector_id AND b.enabled = 1
      ) THEN 1 ELSE enabled END,
    include_tools_json = CASE
      WHEN EXISTS (
        SELECT 1 FROM mcp_scope_migration_conflicts c
        WHERE c.connector_id = mcp_connectors.connector_id AND c.conflict_kind = 'include_tools'
      ) THEN '[]'
      ELSE COALESCE((
        SELECT b.include_tools_json FROM mcp_project_bindings b
        WHERE b.connector_id = mcp_connectors.connector_id
        ORDER BY b.updated_at DESC, b.project_id LIMIT 1
      ), include_tools_json) END,
    exclude_tools_json = CASE
      WHEN EXISTS (
        SELECT 1 FROM mcp_scope_migration_conflicts c
        WHERE c.connector_id = mcp_connectors.connector_id AND c.conflict_kind = 'exclude_tools'
      ) THEN '[]'
      ELSE COALESCE((
        SELECT b.exclude_tools_json FROM mcp_project_bindings b
        WHERE b.connector_id = mcp_connectors.connector_id
        ORDER BY b.updated_at DESC, b.project_id LIMIT 1
      ), exclude_tools_json) END,
    approval_mode = CASE
      WHEN EXISTS (
        SELECT 1 FROM mcp_scope_migration_conflicts c
        WHERE c.connector_id = mcp_connectors.connector_id
          AND c.conflict_kind IN ('enabled', 'include_tools', 'exclude_tools', 'approval_mode')
      ) THEN 'ask'
      ELSE COALESCE((
        SELECT b.approval_mode FROM mcp_project_bindings b
        WHERE b.connector_id = mcp_connectors.connector_id
        ORDER BY b.updated_at DESC, b.project_id LIMIT 1
      ), approval_mode) END;

-- Built-ins are installed capabilities and are available to the default agent.
UPDATE mcp_connectors SET enabled = 1 WHERE source = 'builtin';

CREATE TABLE mcp_global_tool_grants (
  connector_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connector_id, tool_name),
  FOREIGN KEY (connector_id) REFERENCES mcp_connectors(connector_id) ON DELETE CASCADE
) STRICT;

INSERT INTO mcp_global_tool_grants (connector_id, tool_name, decision, updated_at)
SELECT g.connector_id, g.tool_name,
       CASE WHEN COUNT(DISTINCT g.decision) > 1 THEN 'ask' ELSE MAX(g.decision) END,
       MAX(g.updated_at)
FROM mcp_tool_grants g
GROUP BY g.connector_id, g.tool_name;

DROP TABLE mcp_tool_grants;
DROP TABLE mcp_project_bindings;
