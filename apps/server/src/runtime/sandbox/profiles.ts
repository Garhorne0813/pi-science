import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { z } from "zod";
import { canonicalDirectory, identifyPolicy, isWithin, protectedPaths, type SandboxPolicy } from "./policy.js";
import { readOperatorConfig } from "./operator-config.js";

export const SANDBOX_PROFILES = ["analysis", "mcp", "install", "control", "byoc", "candidate"] as const;
export type SandboxProfile = typeof SANDBOX_PROFILES[number];
const host = z.string().max(253).regex(/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/).refine((value) => {
  const [name, port] = value.replace(/^\*\./, "").split(":");
  return !!name && name.includes(".") && !isIP(name) && !name.endsWith(".localhost") && !name.endsWith(".local") && (!port || Number(port) > 0 && Number(port) <= 65535);
}, "Sandbox domains must be public DNS names with an optional port");
const role = z.object({ allowedDomains: z.array(host).max(256).default([]), deniedDomains: z.array(host).max(256).default([]) }).strict();
const schema = z.object({
  schemaVersion: z.literal(1),
  userReadPaths: z.array(z.string().min(1)).max(128).default([]),
  userWritePaths: z.array(z.string().min(1)).max(128).default([]),
  profiles: z.object({ analysis: role.optional(), mcp: role.optional(), install: role.optional(), control: role.optional(), byoc: role.optional() }).strict().default({}),
}).strict();
export const BUILTIN_DENIED_DOMAINS = ["pastebin.com", "*.pastebin.com", "webhook.site", "*.webhook.site", "api.telegram.org", "hooks.slack.com", "metadata.google.internal"];
export const DEFAULT_PACKAGE_DOMAINS = ["conda.anaconda.org:443", "repo.anaconda.com:443", "pypi.org:443", "files.pythonhosted.org:443"];
export async function profileConfiguration() {
  const file = process.env.PI_SCIENCE_SANDBOX_PROFILES;
  const config = schema.parse(file ? await readOperatorConfig(file) : { schemaVersion: 1 });
  return { ...config, file, id: createHash("sha256").update(JSON.stringify({ config, file })).digest("hex") };
}
const defaultPort = (domain: string) => domain.includes(":") ? domain : `${domain}:443`;

/** Called only by trusted execution entry points. Role names are never tool args. */
export async function applySandboxProfile(policy: SandboxPolicy, profile: SandboxProfile): Promise<SandboxPolicy> {
  if (policy.scope === "candidate") {
    if (profile !== "candidate" || policy.network.mode !== "none") throw new Error("Candidate sandbox cannot inherit a broader execution profile");
    return identifyPolicy({ ...policy, profile });
  }
  if (profile === "candidate") throw new Error("Candidate profile requires a candidate binding");
  const config = await profileConfiguration();
  if (config.file && policy.writePaths.some((path) => isWithin(path, config.file!))) throw new Error("Sandbox profile config must be outside writable paths");
  const inheritsGrants = profile === "analysis" || profile === "mcp";
  const reads = inheritsGrants ? await Promise.all(config.userReadPaths.map(canonicalDirectory)) : [];
  const writes = inheritsGrants ? await Promise.all(config.userWritePaths.map(canonicalDirectory)) : [];
  const denied = [...policy.denyPaths];
  for (const path of [...new Set([...reads, ...writes])]) {
    if ([homedir(), "/", "/Users", "/home", "/usr", "/opt", "/etc", "/var", "/private", "/tmp", "/private/tmp"].includes(path)) throw new Error("Host grants require narrow directories");
    if (config.file && isWithin(path, config.file)) throw new Error("Sandbox profile config overlaps a host grant");
    denied.push(...await protectedPaths(path));
  }
  const network = config.profiles[profile] ?? (profile === "install" ? { allowedDomains: DEFAULT_PACKAGE_DOMAINS, deniedDomains: [] } : undefined);
  return identifyPolicy({ ...policy, profile, profilePolicyId: config.id,
    readPaths: [...new Set([...policy.readPaths, ...reads, ...writes])], writePaths: [...new Set([...policy.writePaths, ...writes])], denyPaths: [...new Set(denied)].sort(),
    network: network?.allowedDomains.length ? { mode: "allowlist", allowedDomains: network.allowedDomains.map(defaultPort), deniedDomains: [...BUILTIN_DENIED_DOMAINS, ...network.deniedDomains] } : { mode: "none" },
  });
}
