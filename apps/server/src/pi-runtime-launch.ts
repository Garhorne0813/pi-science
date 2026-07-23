import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { PiConfig } from "@pi-science/contracts";
import type { PiProcessOptions } from "./pi-process.js";
import { configRoot } from "./persistence.js";

export function buildPiProcessOptions(cwd: string, config: PiConfig = { skills: [], extensions: [] }, sessionPath?: string): PiProcessOptions | null {
  const cliPath = process.env.PI_CLI_PATH;
  if (!cliPath) return null;
  const nodePath = process.env.PI_NODE_PATH || process.execPath;
  const dataRoot = configRoot();
  const settings = readSettings(dataRoot);
  const effectiveModel = config.model || (typeof settings.model === "string" ? settings.model : "");
  const effectiveThinking = config.thinking || (typeof settings.thinking === "string" ? settings.thinking : "high");
  const args: string[] = [];
  if (cliPath.endsWith(".ts") && process.env.PI_TSX_PATH) {
    args.push(process.env.PI_TSX_PATH);
    if (process.env.PI_TSCONFIG_PATH) args.push("--tsconfig", process.env.PI_TSCONFIG_PATH);
  }
  args.push(cliPath, "--mode", "rpc", "--session-dir", join(cwd, ".pi-science", "sessions"), "--no-extensions");
  if (effectiveModel) args.push("--model", effectiveModel);
  if (effectiveThinking) args.push("--thinking", effectiveThinking);
  if (sessionPath) args.push("--session", sessionPath);
  for (const skill of config.skills) args.push("--skill", skill);
  for (const extension of config.extensions) args.push("-e", extension);
  const workspaceKey = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12);
  let agentDir = join(dataRoot, "pi-agent", workspaceKey);
  try {
    mkdirSync(agentDir, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") throw error;
    agentDir = join(resolve(cwd), ".pi-science", "agent", workspaceKey);
    mkdirSync(agentDir, { recursive: true });
  }
  const storedKeys = settings.api_keys;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CONFIG_DIR: agentDir,
    PI_WORKSPACE_DIR: resolve(cwd),
    CONTEXT_MODE_DATA_DIR: agentDir,
    CONTEXT_MODE_DIR: join(agentDir, "context-mode"),
    ...(config.provider ? { PI_DEFAULT_PROVIDER: config.provider } : {}),
  };
  if (storedKeys && typeof storedKeys === "object") {
    for (const [provider, key] of Object.entries(storedKeys)) {
      if (typeof key !== "string" || !key) continue;
      const envName = providerEnv(provider);
      if (envName) env[envName] = key;
    }
  }
  materializeCustomProviders(agentDir, settings.custom_providers, env);

  return {
    cwd,
    command: nodePath,
    args,
    env,
  };
}

export function loadDefaultPiConfig(): PiConfig {
  const dataRoot = configRoot();
  const settings = readSettings(dataRoot);
  return {
    model: typeof settings.model === "string" && settings.model ? settings.model : null,
    thinking: typeof settings.thinking === "string" && settings.thinking ? settings.thinking : null,
    provider: null,
    api_key: null,
    skills: Array.isArray(settings.skill_paths) ? settings.skill_paths.map(String).filter(Boolean) : [],
    extensions: Array.isArray(settings.extension_paths)
      ? settings.extension_paths.map(String).filter(Boolean)
      : runtimeExtensionStatus().filter((item) => item.installed && (item.id !== "context-mode" || process.env.PI_SCIENCE_ENABLE_CONTEXT_MODE === "1")).map((item) => item.path!).filter(Boolean),
  };
}

const EXTENSIONS = [
  { id: "pi-mcp-adapter", name: "MCP Adapter", description: "Bridges configured MCP servers into Pi." },
  { id: "pi-subagents", name: "Subagents", description: "Adds focused scientific subagents." },
  { id: "pi-web-access", name: "Web Access", description: "Adds web search, URL fetching, and media extraction." },
  { id: "context-mode", name: "Context Mode", description: "Optional sandboxed context index.", entrypoints: ["build/adapters/pi/extension.js"] },
] as const;

export function runtimeExtensionStatus(cliPath = process.env.PI_CLI_PATH ?? ""): Array<{ id: string; name: string; description: string; installed: boolean; path: string | null }> {
  return EXTENSIONS.map((extension) => {
    const path = findRuntimeExtension(extension.id, cliPath, "entrypoints" in extension ? [...extension.entrypoints] : []);
    return { id: extension.id, name: extension.name, description: extension.description, installed: Boolean(path), path };
  });
}

function findRuntimeExtension(packageName: string, cliPath: string, extraEntrypoints: string[]): string | null {
  if (!cliPath) return null;
  const roots: string[] = [];
  let current = dirname(resolve(cliPath));
  for (let depth = 0; depth < 12; depth += 1) {
    if (!roots.includes(current)) roots.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const root of roots) {
    const packageDir = join(root, "node_modules", packageName);
    const entrypoints: string[] = [];
    try {
      const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { pi?: { extensions?: unknown } };
      if (Array.isArray(manifest.pi?.extensions)) entrypoints.push(...manifest.pi.extensions.map(String));
    } catch { /* try conventional entrypoints */ }
    entrypoints.push(...extraEntrypoints, "index.ts", "index.js", "dist/index.js");
    for (const entrypoint of [...new Set(entrypoints)]) {
      const candidate = join(packageDir, entrypoint);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function readSettings(dataRoot: string): Record<string, any> {
  try { return JSON.parse(readFileSync(join(resolve(dataRoot), "config.json"), "utf8")) as Record<string, any>; }
  catch { return {}; }
}

function providerEnv(provider: string): string | null {
  const names: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY", groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY",
    mistral: "MISTRAL_API_KEY", xai: "XAI_API_KEY", zai: "ZAI_API_KEY", fireworks: "FIREWORKS_API_KEY",
    together: "TOGETHER_API_KEY",
  };
  return names[provider] ?? null;
}

function materializeCustomProviders(agentDir: string, raw: unknown, env: NodeJS.ProcessEnv): void {
  const path = join(agentDir, "models.json");
  if (!Array.isArray(raw) || raw.length === 0) {
    try { unlinkSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  const providers: Record<string, unknown> = {};
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const provider = item as Record<string, unknown>;
    const id = slug(String(provider.id ?? provider.name ?? "custom-api"));
    const providerId = `custom-${id}`;
    const models = Array.isArray(provider.models) ? provider.models.map(String).filter(Boolean) : [];
    const envName = `PI_SCIENCE_CUSTOM_${id.toUpperCase().replaceAll("-", "_")}_API_KEY`;
    const modelDefinitions = models.map((model) => ({
      id: model, name: model, reasoning: /gpt-5|thinking|reasoning|qwen3|deepseek-r1/i.test(model),
      input: ["text"], contextWindow: 128000, maxTokens: 16384,
      ...( /gpt-5|thinking|reasoning|qwen3|deepseek-r1/i.test(model) ? { thinkingLevelMap: { off: "none", xhigh: "xhigh" } } : {}),
    }));
    const apiKey = typeof provider.api_key === "string" ? provider.api_key : "";
    if (apiKey) env[envName] = apiKey;
    providers[providerId] = {
      name: String(provider.name ?? "Custom API"), baseUrl: String(provider.base_url ?? ""),
      api: String(provider.api ?? "openai-completions"), models: modelDefinitions,
      ...(apiKey ? { apiKey: `$${envName}` } : {}),
    };
  }
  writeFileSync(path, `${JSON.stringify({ providers }, null, 2)}\n`, "utf8");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "custom-api";
}
