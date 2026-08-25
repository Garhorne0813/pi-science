const RESEARCH_ENVIRONMENT_KEY_NAMES = ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "USER", "LOGNAME", "SHELL", "PYTHONNOUSERSITE", "PIP_USER", "CONDA_PREFIX", "PI_SCIENCE_ENVIRONMENT_PREFIX", "npm_config_prefix", "npm_config_cache", "npm_config_update_notifier", "PNPM_HOME", "COREPACK_HOME"] as const;
const RESEARCH_ENVIRONMENT_KEYS = new Map(RESEARCH_ENVIRONMENT_KEY_NAMES.map((key) => [key.toLowerCase(), key]));

const LOCAL_JOB_ENVIRONMENT_KEY_NAMES = [
  ...RESEARCH_ENVIRONMENT_KEY_NAMES,
  "PI_SCIENCE_ENVIRONMENT_ID",
  "PI_SCIENCE_ENVIRONMENT_REVISION_ID",
  "NPM_CONFIG_PREFIX",
  "NPM_CONFIG_CACHE",
  "npm_config_registry",
  "NPM_CONFIG_REGISTRY",
  "PIP_INDEX_URL",
  "PIP_EXTRA_INDEX_URL",
  "PIP_TRUSTED_HOST",
  "UV_INDEX_URL",
  "UV_EXTRA_INDEX_URL",
  "YARN_NPM_REGISTRY_SERVER",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "CUDA_VISIBLE_DEVICES",
  "NVIDIA_VISIBLE_DEVICES",
  "ROCR_VISIBLE_DEVICES",
  "HIP_VISIBLE_DEVICES",
  "GPU_DEVICE_ORDINAL",
  "CUDA_PATH",
  "CUDA_HOME",
  "ROCM_PATH",
  "HIP_PATH",
  "NVIDIA_DRIVER_CAPABILITIES",
  "ProgramFiles",
  "ProgramData",
] as const;
const LOCAL_JOB_ENVIRONMENT_KEYS = new Map(LOCAL_JOB_ENVIRONMENT_KEY_NAMES.map((key) => [key.toLowerCase(), key]));
const LOCAL_JOB_URL_ENVIRONMENT_KEYS = new Set([
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "pip_index_url",
  "pip_extra_index_url",
  "uv_index_url",
  "uv_extra_index_url",
  "npm_config_registry",
  "yarn_npm_registry_server",
]);

export function restrictResearchEnvironment(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return restrictEnvironmentKeys(environment, RESEARCH_ENVIRONMENT_KEY_NAMES, RESEARCH_ENVIRONMENT_KEYS, platform, false);
}

export function restrictLocalJobEnvironment(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return restrictEnvironmentKeys(environment, LOCAL_JOB_ENVIRONMENT_KEY_NAMES, LOCAL_JOB_ENVIRONMENT_KEYS, platform, true);
}

function sanitizeLocalJobEnvironmentValue(key: string, value: string): string | undefined {
  if (!LOCAL_JOB_URL_ENVIRONMENT_KEYS.has(key.toLowerCase())) return value;
  // Package indexes may contain several whitespace-separated URLs. Strip
  // credentials before passing them to a child process; the URL itself is
  // still useful for local mirrors and proxies, while embedded tokens are not.
  return value.split(/\s+/).filter(Boolean).map((part) => {
    try {
      const url = new URL(part);
      if (!url.protocol || !url.hostname) return "";
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "";
    }
  }).filter(Boolean).join(" ");
}

function restrictEnvironmentKeys(environment: NodeJS.ProcessEnv, keyNames: readonly string[], canonicalKeys: Map<string, string>, platform: NodeJS.Platform, sanitizeValues: boolean): NodeJS.ProcessEnv {
  const restricted: NodeJS.ProcessEnv = {};
  for (const key of keyNames) {
    const value = environment[key];
    if (value === undefined) continue;
    const sanitized = sanitizeValues ? sanitizeLocalJobEnvironmentValue(key, value) : value;
    if (sanitized !== undefined) restricted[key] = sanitized;
  }
  if (platform !== "win32") return restricted;
  for (const [key, value] of Object.entries(environment)) {
    const canonical = canonicalKeys.get(key.toLowerCase());
    if (canonical && value !== undefined && restricted[canonical] === undefined) {
      const sanitized = sanitizeValues ? sanitizeLocalJobEnvironmentValue(canonical, value) : value;
      if (sanitized !== undefined) restricted[canonical] = sanitized;
    }
  }
  return restricted;
}
