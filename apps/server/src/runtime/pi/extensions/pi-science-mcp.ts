import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

type Binding = { kind: "literal"; value: string } | { kind: "environment"; name: string } | { kind: "credential"; credential_ref: string };
type ProjectedServer = Record<string, unknown> & { __piScienceEnvironment?: Record<string, Binding>; __piScienceHeaders?: Record<string, Binding> };

export default async function piScienceMcp(pi: unknown): Promise<void> {
  const workspace = process.env.PI_WORKSPACE_DIR ?? process.cwd();
  let projected: { mcpServers?: Record<string, ProjectedServer> } = {};
  try { projected = JSON.parse(readFileSync(join(workspace, ".pi-science", "mcp-runtime.json"), "utf8")) as typeof projected; }
  catch { /* No canonical bindings means an intentionally empty MCP snapshot. */ }
  const mcpServers = Object.fromEntries(Object.entries(projected.mcpServers ?? {}).map(([name, raw]) => {
    const { __piScienceEnvironment, __piScienceHeaders, ...server } = raw;
    const env = materialize(__piScienceEnvironment);
    const headers = materialize(__piScienceHeaders);
    return [name, {
      ...server,
      __piScienceRawBindings: true,
      __piScienceFetchModule: new URL(existsSync(new URL("../../../mcp/runtime-fetch.js", import.meta.url)) ? "../../../mcp/runtime-fetch.js" : "../../../mcp/runtime-fetch.ts", import.meta.url).href,
      ...(env ? { env } : {}),
      ...(headers ? { headers } : {}),
    }];
  }));
  // Keep the adapter outside the server's TypeScript compilation boundary;
  // Pi's runtime source loader owns this package and executes its TS sources.
  const adapterPath = process.env.PI_SCIENCE_MCP_ADAPTER_PATH;
  if (!adapterPath) throw new Error("PI_SCIENCE_MCP_ADAPTER_PATH is required for managed MCP");
  const manager = readFileSync(join(dirname(adapterPath), "server-manager.ts"), "utf8");
  const approval = readFileSync(join(dirname(adapterPath), "tool-approval.ts"), "utf8");
  if (!manager.includes("PI_SCIENCE_TRANSPORT_POLICY_V1") || !manager.includes("PI_SCIENCE_RAW_BINDINGS_V1") || !approval.includes("PI_SCIENCE_EXACT_TOOL_GRANTS_V1")) {
    throw new Error("MCP adapter security patches are missing; run scripts/fetch-pi.sh");
  }
  const adapterUrl = pathToFileURL(adapterPath).href;
  const adapter = await import(adapterUrl) as { createMcpAdapter: (options: unknown) => (api: unknown) => void };
  adapter.createMcpAdapter({ config: { mcpServers, settings: { directTools: false, hostConfigDiscovery: "off" } } })(pi);
}

function materialize(bindings?: Record<string, Binding>): Record<string, string> | undefined {
  if (!bindings || !Object.keys(bindings).length) return undefined;
  const output: Record<string, string> = {};
  for (const [key, binding] of Object.entries(bindings)) {
    if (binding.kind !== "environment") throw new Error("Unsupported MCP binding; use an environment reference");
    if (process.env[binding.name] === undefined) throw new Error(`Missing MCP environment variable: ${binding.name}`);
    output[key] = process.env[binding.name]!;
  }
  return output;
}
