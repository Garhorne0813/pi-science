ALTER TABLE mcp_connectors ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1));
ALTER TABLE mcp_connectors ADD COLUMN include_tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(include_tools_json));
ALTER TABLE mcp_connectors ADD COLUMN exclude_tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exclude_tools_json));
ALTER TABLE mcp_connectors ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'ask' CHECK (approval_mode IN ('ask', 'custom', 'allow_all'));
ALTER TABLE mcp_connectors ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 1;

-- Preserve the most recent project policy while making enablement global. If
-- any project used a connector, keep it enabled after the scope migration.
UPDATE mcp_connectors
SET enabled = CASE WHEN EXISTS (
      SELECT 1 FROM mcp_project_bindings b
      WHERE b.connector_id = mcp_connectors.connector_id AND b.enabled = 1
    ) THEN 1 ELSE enabled END,
    include_tools_json = COALESCE((
      SELECT b.include_tools_json FROM mcp_project_bindings b
      WHERE b.connector_id = mcp_connectors.connector_id
      ORDER BY b.updated_at DESC, b.project_id LIMIT 1
    ), include_tools_json),
    exclude_tools_json = COALESCE((
      SELECT b.exclude_tools_json FROM mcp_project_bindings b
      WHERE b.connector_id = mcp_connectors.connector_id
      ORDER BY b.updated_at DESC, b.project_id LIMIT 1
    ), exclude_tools_json),
    approval_mode = COALESCE((
      SELECT b.approval_mode FROM mcp_project_bindings b
      WHERE b.connector_id = mcp_connectors.connector_id
      ORDER BY b.updated_at DESC, b.project_id LIMIT 1
    ), approval_mode);

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
SELECT g.connector_id, g.tool_name, g.decision, g.updated_at
FROM mcp_tool_grants g
WHERE g.rowid = (
  SELECT latest.rowid FROM mcp_tool_grants latest
  WHERE latest.connector_id = g.connector_id AND latest.tool_name = g.tool_name
  ORDER BY latest.updated_at DESC, latest.project_id LIMIT 1
);

DROP TABLE mcp_tool_grants;
DROP TABLE mcp_project_bindings;
