import { builtinNetworkEnvironment } from "../../../mcp/bindings.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CredentialStore } from "../../../model-resources/credential-store.js";

type Binding = { kind: "literal"; value: string } | { kind: "environment"; name: string } | { kind: "credential"; credential_ref: string; prefix?: string };
type ProjectedServer = Record<string, unknown> & { __piScienceEnvironment?: Record<string, Binding>; __piScienceHeaders?: Record<string, Binding> };
type ProjectedSnapshot = { version: 1; project_id: string; mcpServers: Record<string, ProjectedServer> };

export function loadProjectedServers(workspace: string, onBindingError?: (name: string, error: unknown) => void,
  acceptServer: (name: string) => boolean = () => true): Record<string, Record<string, unknown>> {
  const projected = loadProjectedSnapshot(workspace);
  return Object.fromEntries(Object.entries(projected.mcpServers ?? {}).flatMap(([name, raw]) => {
    // Scope before resolving any environment/header credential bindings.
    if (!acceptServer(name)) return [];
    try {
      const { __piScienceEnvironment, __piScienceHeaders, ...server } = raw;
      const env = { ...materialize(__piScienceEnvironment), ...(server.__piScienceBuiltin ? builtinNetworkEnvironment() : {}) };
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
