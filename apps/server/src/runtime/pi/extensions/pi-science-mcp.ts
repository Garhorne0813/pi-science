import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CredentialStore } from "../../../model-resources/credential-store.js";

type Binding = { kind: "literal"; value: string } | { kind: "environment"; name: string } | { kind: "credential"; credential_ref: string; prefix?: string };
type ProjectedServer = Record<string, unknown> & { __piScienceEnvironment?: Record<string, Binding>; __piScienceHeaders?: Record<string, Binding> };
type ProjectedSnapshot = { version: 1; project_id: string; mcpServers: Record<string, ProjectedServer> };

export default async function piScienceMcp(pi: unknown): Promise<void> {
  // Pi Orbit is a shared host. This extension is loaded once in the host, but
  // each session can belong to a different workspace. Resolve the managed
  // snapshot from the session context instead of capturing the host cwd here.
  // The adapter's configFactory is a Pi-Science patch applied at install time.
  const configFactory = (ctx: { cwd: string }) => ({
    mcpServers: loadProjectedServers(ctx.cwd),
    settings: { directTools: false, hostConfigDiscovery: "off" },
  });

  // Keep the adapter outside the server's TypeScript compilation boundary;
  // Pi's runtime source loader owns this package and executes its TS sources.
  const adapterPath = process.env.PI_SCIENCE_MCP_ADAPTER_PATH;
  if (!adapterPath) throw new Error("PI_SCIENCE_MCP_ADAPTER_PATH is required for managed MCP");
  const manager = readFileSync(join(dirname(adapterPath), "server-manager.ts"), "utf8");
  const authFlow = readFileSync(join(dirname(adapterPath), "mcp-auth-flow.ts"), "utf8");
  const probe = readFileSync(join(dirname(adapterPath), "mcp-probe.ts"), "utf8");
  const approval = readFileSync(join(dirname(adapterPath), "tool-approval.ts"), "utf8");
  const adapterSource = readFileSync(adapterPath, "utf8");
  if (!manager.includes("PI_SCIENCE_TRANSPORT_POLICY_V1") || !manager.includes("PI_SCIENCE_RAW_BINDINGS_V1") || !manager.includes("PI_SCIENCE_PROJECT_EGRESS_AUDIT_V1") || !manager.includes("PI_SCIENCE_PROBE_TRANSPORT_POLICY_V1") || !authFlow.includes("PI_SCIENCE_OAUTH_TRANSPORT_POLICY_V1") || !probe.includes("PI_SCIENCE_PROBE_TRANSPORT_POLICY_V1") || !approval.includes("PI_SCIENCE_EXACT_TOOL_GRANTS_V1") || !approval.includes("PI_SCIENCE_PERMISSION_UI_V1") || !adapterSource.includes("PI_SCIENCE_SESSION_CONFIG_FACTORY_V1")) {
    throw new Error("MCP adapter security/session patches are missing; run scripts/fetch-pi.sh");
  }
  const adapterUrl = pathToFileURL(adapterPath).href;
  const adapter = await import(adapterUrl) as { createMcpAdapter: (options: unknown) => (api: unknown) => void };
  adapter.createMcpAdapter({ configFactory })(pi);
}

export function loadProjectedServers(workspace: string, onBindingError?: (name: string, error: unknown) => void): Record<string, Record<string, unknown>> {
  const projected = loadProjectedSnapshot(workspace);
  return Object.fromEntries(Object.entries(projected.mcpServers ?? {}).flatMap(([name, raw]) => {
    try {
      const { __piScienceEnvironment, __piScienceHeaders, ...server } = raw;
      const env = materialize(__piScienceEnvironment);
      const headers = materialize(__piScienceHeaders);
      return [[name, {
        ...server,
        __piScienceProjectId: projected.project_id,
        __piScienceRawBindings: true,
        __piScienceFetchModule: new URL(existsSync(new URL("../../../mcp/runtime-fetch.js", import.meta.url)) ? "../../../mcp/runtime-fetch.js" : "../../../mcp/runtime-fetch.ts", import.meta.url).href,
        ...(env ? { env } : {}),
        ...(headers ? { headers } : {}),
      }]];
    } catch (error) {
      if (!onBindingError) throw error;
      onBindingError(name, error);
      return [];
    }
  }));
}

/** Environment bindings must be admitted to the child before it materializes MCP. */
export function projectedEnvironmentNames(workspace: string): string[] {
  const names = new Set<string>();
  for (const server of Object.values(loadProjectedSnapshot(workspace).mcpServers)) {
    for (const bindings of [server.__piScienceEnvironment, server.__piScienceHeaders]) {
      for (const binding of Object.values(bindings ?? {})) {
        if (binding.kind === "environment" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.name)) names.add(binding.name);
      }
    }
  }
  return [...names];
}

function loadProjectedSnapshot(workspace: string): ProjectedSnapshot {
  let projected: ProjectedSnapshot = { version: 1, project_id: "empty", mcpServers: {} };
  const stateRoot = process.env.PI_SCIENCE_STATE_ROOT;
  let snapshotPath = join(workspace, ".pi-science", "mcp-runtime.json");
  if (stateRoot) {
    const canonical = canonicalPathSync(resolve(workspace));
    const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    const relocated = join(stateRoot, "workspaces", createHash("sha256").update(identity).digest("hex"), "mcp-runtime.json");
    if (existsSync(relocated) || !existsSync(snapshotPath)) snapshotPath = relocated;
  }
  try {
    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as Partial<ProjectedSnapshot>;
    if (parsed.version !== 1 || typeof parsed.project_id !== "string" || !parsed.project_id || !parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) {
      throw new Error("MCP runtime snapshot has an invalid schema");
    }
    projected = parsed as ProjectedSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Unable to load MCP runtime snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }
  return projected;
}

function canonicalPathSync(path: string): string {
  try { return realpathSync.native(path); }
  catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonicalPathSync(parent), basename(path));
  }
}

function materialize(bindings?: Record<string, Binding>): Record<string, string> | undefined {
  if (!bindings || !Object.keys(bindings).length) return undefined;
  const output: Record<string, string> = {};
  const credentials = new CredentialStore();
  for (const [key, binding] of Object.entries(bindings)) {
    if (binding.kind === "literal") throw new Error("Unsupported MCP literal binding");
    const value = binding.kind === "environment" ? process.env[binding.name] : credentials.readSync(binding.credential_ref)?.secret;
    if (value === undefined || value === null) throw new Error(binding.kind === "environment" ? `Missing MCP environment variable: ${binding.name}` : `Missing MCP credential: ${binding.credential_ref}`);
    output[key] = `${binding.kind === "credential" ? binding.prefix ?? "" : ""}${value}`;
  }
  return output;
}
