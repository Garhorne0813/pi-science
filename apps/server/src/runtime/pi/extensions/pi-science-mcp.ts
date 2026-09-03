import { readFileSync } from "node:fs";
import { join } from "node:path";

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
      ...(env ? { env } : {}),
      ...(headers ? { headers } : {}),
    }];
  }));
  // Keep the adapter outside the server's TypeScript compilation boundary;
  // Pi's runtime source loader owns this package and executes its TS sources.
  const adapterUrl = new URL("../../../../../../runtime/pi/node_modules/pi-mcp-adapter/index.ts", import.meta.url).href;
  const adapter = await import(adapterUrl) as { createMcpAdapter: (options: unknown) => (api: unknown) => void };
  adapter.createMcpAdapter({ config: { mcpServers, settings: { directTools: false, hostConfigDiscovery: "off" } } })(pi);
}

function materialize(bindings?: Record<string, Binding>): Record<string, string> | undefined {
  if (!bindings || !Object.keys(bindings).length) return undefined;
  const output: Record<string, string> = {};
  for (const [key, binding] of Object.entries(bindings)) {
    if (binding.kind === "literal") output[key] = binding.value;
    else if (binding.kind === "environment" && process.env[binding.name] !== undefined) output[key] = process.env[binding.name]!;
    // Credential references are deliberately never serialized into the snapshot.
  }
  return output;
}
