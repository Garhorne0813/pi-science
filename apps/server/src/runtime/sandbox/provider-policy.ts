import { join } from "node:path";
import { canonicalDirectory, identifyPolicy, protectedPaths } from "./policy.js";
import { applySandboxProfile } from "./profiles.js";
import { domainAllowed } from "./network.js";
import { pathsOverlap, runtimeDependencyGrants, runtimeReadPolicy } from "./read-grants.js";

/** Trusted provider registration supplies these roots and endpoint. They are
 * not model/tool parameters. Each helper gets its own proxy and policy digest. */
export async function providerHelperPolicy(input: { workspace: string; stage: string; runtime: string; endpoint?: string }) {
  const workspace = await canonicalDirectory(input.workspace), stage = await canonicalDirectory(input.stage), runtime = await canonicalDirectory(input.runtime);
  await runtimeDependencyGrants(await runtimeReadPolicy(), [runtime]);
  if ([workspace, stage].some((path) => pathsOverlap(path, runtime))) throw new Error("Provider SDK must be outside writable helper paths");
  const carveOuts = [".venv", ".r-libs", ".cache", ".tmp", "uv.toml", "pyproject.toml", ".Rprofile", ".Renviron"].map((name) => join(workspace, name));
  const policy = await applySandboxProfile(identifyPolicy({ mode: "required", scope: "workspace", cwd: workspace,
    readPaths: [workspace, stage, runtime], writePaths: [workspace, stage],
    denyPaths: [...new Set([...await protectedPaths(workspace), ...await protectedPaths(stage), ...carveOuts])].sort(), network: { mode: "none" },
  }), "byoc");
  if (!input.endpoint) return identifyPolicy({ ...policy, network: { mode: "none" } });
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) throw new Error("Provider helpers require a registered HTTPS endpoint without embedded credentials");
  const port = Number(endpoint.port || 443);
  if (!domainAllowed(endpoint.hostname, port, policy.network)) throw new Error("Provider endpoint is not approved by the operator BYOC allowlist");
  return identifyPolicy({ ...policy, network: { mode: "allowlist", allowedDomains: [`${endpoint.hostname}:${port}`], deniedDomains: policy.network.mode === "allowlist" ? policy.network.deniedDomains : [] } });
}
