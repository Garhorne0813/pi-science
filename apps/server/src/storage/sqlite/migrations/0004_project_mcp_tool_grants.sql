CREATE TABLE mcp_project_tool_grants (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, connector_id, tool_name),
  FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
  FOREIGN KEY (connector_id) REFERENCES mcp_connectors(connector_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX mcp_project_tool_grants_connector_idx
  ON mcp_project_tool_grants(project_id, connector_id);
