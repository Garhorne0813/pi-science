/** Variables ordinary tools need; authentication stays in the worker only. */
const TOOL_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT",
  "LANG", "LC_ALL", "LC_CTYPE", "CONDA_PREFIX", "PYTHONNOUSERSITE", "PIP_USER",
  "PI_SCIENCE_ENVIRONMENT_ID", "PI_SCIENCE_ENVIRONMENT_REVISION_ID", "PI_SCIENCE_ENVIRONMENT_PREFIX",
  "npm_config_prefix", "NPM_CONFIG_PREFIX", "npm_config_cache", "NPM_CONFIG_CACHE",
  "npm_config_update_notifier", "PNPM_HOME", "COREPACK_HOME",
]);

export function toolEnvironment(environment: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(environment)
    .filter((entry): entry is [string, string] => TOOL_ENV_KEYS.has(entry[0]) && entry[1] !== undefined));
}
