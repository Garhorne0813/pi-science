import { createHash } from "node:crypto";
import type { StoredMcpConnector } from "../storage/sqlite/repositories/mcp-repository.js";

export function mcpConnectorFingerprint(connector: StoredMcpConnector): string {
  return createHash("sha256").update(JSON.stringify({ transport: connector.transport, endpoint_url: connector.endpoint_url, command: connector.command, args: connector.args, socket_path: connector.socket_path, runtime_config: connector.runtime_config, revision: connector.revision })).digest("hex");
}
