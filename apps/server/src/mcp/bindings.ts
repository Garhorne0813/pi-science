import type { McpRuntimeConfig } from "@pi-science/contracts";

/** Until a credential delivery channel exists, never silently drop bindings. */
export function bindingError(config: McpRuntimeConfig, credentialRef?: string | null): string | null {
  const values = [...Object.values(config.environment), ...Object.values(config.headers)];
  if (credentialRef || values.some((value) => value.kind === "credential")) return "Credential references are not supported for MCP yet; use an environment reference";
  if (values.some((value) => value.kind === "literal")) return "MCP env and headers must use environment references; literal values are not stored";
  return null;
}

export function resolveBindings(values: McpRuntimeConfig["environment"]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, binding] of Object.entries(values)) {
    if (binding.kind !== "environment") throw new Error("MCP binding must use an environment reference");
    const value = process.env[binding.name];
    if (value === undefined) throw new Error(`Missing MCP environment variable: ${binding.name}`);
    output[key] = value;
  }
  return output;
}

export function mcpBaseEnvironment(): Record<string, string> {
  return Object.fromEntries(["PI_SCIENCE_HOME", "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}
