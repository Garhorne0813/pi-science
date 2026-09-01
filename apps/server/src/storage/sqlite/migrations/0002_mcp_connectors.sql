CREATE TABLE mcp_connectors (
  connector_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('builtin', 'custom', 'imported')),
  transport TEXT NOT NULL CHECK (transport IN ('stdio', 'streamable_http', 'sse', 'socket')),
  endpoint_url TEXT,
  command TEXT,
  args_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(args_json)),
  socket_path TEXT,
  runtime_config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(runtime_config_json)),
  credential_ref TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (transport = 'stdio' AND command IS NOT NULL AND endpoint_url IS NULL AND socket_path IS NULL) OR
    (transport IN ('streamable_http', 'sse') AND endpoint_url IS NOT NULL AND command IS NULL AND socket_path IS NULL) OR
    (transport = 'socket' AND socket_path IS NOT NULL AND endpoint_url IS NULL AND command IS NULL)
  )
) STRICT;

CREATE TABLE mcp_project_bindings (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  include_tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(include_tools_json)),
  exclude_tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exclude_tools_json)),
  approval_mode TEXT NOT NULL DEFAULT 'ask' CHECK (approval_mode IN ('ask', 'custom', 'allow_all')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, connector_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
  FOREIGN KEY (connector_id) REFERENCES mcp_connectors(connector_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX mcp_project_bindings_connector_idx ON mcp_project_bindings(connector_id);

CREATE TABLE mcp_tool_grants (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, connector_id, tool_name),
  FOREIGN KEY (project_id, connector_id) REFERENCES mcp_project_bindings(project_id, connector_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE mcp_tool_cache (
  connector_id TEXT PRIMARY KEY,
  config_revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  tools_json TEXT NOT NULL CHECK (json_valid(tools_json)),
  resources_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(resources_json)),
  server_info_json TEXT CHECK (server_info_json IS NULL OR json_valid(server_info_json)),
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (connector_id) REFERENCES mcp_connectors(connector_id) ON DELETE CASCADE
) STRICT;
