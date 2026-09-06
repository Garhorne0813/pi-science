import type { McpRuntimeConfig } from "@pi-science/contracts";
import { CredentialStore } from "../model-resources/credential-store.js";

export function bindingError(config: McpRuntimeConfig, credentialRef?: string | null): string | null {
  const values = [...Object.values(config.environment), ...Object.values(config.headers)];
  if (values.some((value) => value.kind === "literal")) return "MCP env and headers must use environment references; literal values are not stored";
  const credentialBindings = values.filter((value) => value.kind === "credential");
  if (credentialBindings.length && !credentialRef) return "MCP credential bindings must be managed from the connector authentication settings";
  if (credentialRef && !credentialBindings.some((value) => value.credential_ref === credentialRef)) return "MCP credential is not bound to an environment variable or header";
  if (credentialBindings.some((value) => value.credential_ref !== credentialRef)) return "MCP credential binding does not match the connector credential reference";
  return null;
}

export function resolveBindings(values: McpRuntimeConfig["environment"], credentials: CredentialStore = new CredentialStore()): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, binding] of Object.entries(values)) {
    if (binding.kind === "literal") throw new Error("MCP binding must use an environment or credential reference");
    const value = binding.kind === "environment" ? process.env[binding.name] : credentials.readSync(binding.credential_ref)?.secret;
    if (value === undefined || value === null) throw new Error(binding.kind === "environment" ? `Missing MCP environment variable: ${binding.name}` : `Missing MCP credential: ${binding.credential_ref}`);
    output[key] = `${binding.kind === "credential" ? binding.prefix ?? "" : ""}${value}`;
  }
  return output;
}

export function mcpBaseEnvironment(): Record<string, string> {
  return Object.fromEntries(["PI_SCIENCE_HOME", "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}
