import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import type { PiConfig } from "@pi-science/contracts";
import type { PiProcessOptions } from "./pi-process.js";
import { configRoot } from "./persistence.js";

export function buildPiProcessOptions(cwd: string, config: PiConfig = { skills: [], extensions: [] }, sessionPath?: string, workspaceEnvironment: NodeJS.ProcessEnv = {}): PiProcessOptions | null {
  const cliPath = process.env.PI_CLI_PATH;
  if (!cliPath) return null;
  const nodePath = process.env.PI_NODE_PATH || process.execPath;
  const dataRoot = configRoot();
  const settings = readSettings(dataRoot);
  const effectiveModel = config.model || (typeof settings.model === "string" ? settings.model : "");
  const effectiveThinking = config.thinking || (typeof settings.thinking === "string" ? settings.thinking : "high");
  const args: string[] = [];
  const seededSkills = seedWorkspaceAssets(cwd);
  if (cliPath.endsWith(".ts")) {
    const tsxPath = process.env.PI_TSX_PATH || findAdjacentRuntime(cliPath, join("node_modules", ".bin", "tsx"));
    if (!tsxPath) throw new Error(`TypeScript Pi CLI requires tsx: ${cliPath}`);
    args.push(tsxPath);
    if (process.env.PI_TSCONFIG_PATH) args.push("--tsconfig", process.env.PI_TSCONFIG_PATH);
  }
  args.push(cliPath, "--mode", "rpc", "--session-dir", join(cwd, ".pi-science", "sessions"), "--no-extensions");
  const subagentsExtension = findRuntimeExtension("pi-subagents", cliPath, []);
  if (subagentsExtension) args.push("-e", subagentsExtension);
  if (effectiveModel) args.push("--model", effectiveModel);
  if (effectiveThinking) args.push("--thinking", effectiveThinking);
  if (sessionPath) args.push("--session", sessionPath);
  for (const skill of [...seededSkills, ...config.skills]) args.push("--skill", skill);
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
    ...workspaceEnvironment,
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
  materializeRuntimeSettings(agentDir, settings, config);
  materializeFollowUpGuidance(agentDir);

  return {
    cwd,
    command: nodePath,
    args,
    env,
  };
}

function seedWorkspaceAssets(cwd: string): string[] {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
  const metadata = join(cwd, ".pi-science");
  mkdirSync(metadata, { recursive: true });
  const agents = join(cwd, "AGENTS.md");
  const sourceAgents = join(projectRoot, "harness", "AGENTS.md");
  if (!existsSync(agents) && existsSync(sourceAgents)) cpSync(sourceAgents, agents);
  const sourceSkills = join(projectRoot, "skills");
  const targetSkills = join(cwd, ".pi", "skills");
  mkdirSync(targetSkills, { recursive: true });
  const result: string[] = [];
  for (const name of readdirSync(sourceSkills, { withFileTypes: true })) {
    if (!name.isDirectory() || !existsSync(join(sourceSkills, name.name, "SKILL.md"))) continue;
    const target = join(targetSkills, name.name);
    mkdirSync(target, { recursive: true });
    cpSync(join(sourceSkills, name.name, "SKILL.md"), join(target, "SKILL.md"));
    result.push(target);
  }
  return result;
}

function findAdjacentRuntime(sourcePath: string, relativePath: string): string | null {
  let current = dirname(resolve(sourcePath));
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function loadDefaultPiConfig(): PiConfig {
  const dataRoot = configRoot();
  const settings = readSettings(dataRoot);
  return {
    model: typeof settings.model === "string" && settings.model ? settings.model : null,
    thinking: typeof settings.thinking === "string" && settings.thinking ? settings.thinking : null,
    compaction_enabled: settings.compaction_enabled !== false,
    compaction_threshold_percent: validThreshold(settings.compaction_threshold_percent),
    model_context_window: positiveInteger(settings.model_context_window),
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
    const configuredReasoning = typeof provider.reasoning === "boolean" ? provider.reasoning : undefined;
    const configuredContextWindow = positiveInteger(provider.context_window) ?? 128000;
    const hints = provider.model_hints && typeof provider.model_hints === "object" ? provider.model_hints as Record<string, any> : {};
    const envName = `PI_SCIENCE_CUSTOM_${id.toUpperCase().replaceAll("-", "_")}_API_KEY`;
    const modelDefinitions = models.map((model) => {
      const hint = hints[model] ?? {};
      const reasoning = typeof hint.reasoning === "boolean" ? hint.reasoning : configuredReasoning ?? /gpt-5|thinking|reasoning|qwen3|deepseek-r1|deepseek-v4/i.test(model);
      return {
        id: model, name: model, reasoning,
        input: ["text"], contextWindow: positiveInteger(hint.context_window) ?? configuredContextWindow, maxTokens: 16384,
        ...(reasoning ? { thinkingLevelMap: Object.fromEntries((Array.isArray(hint.thinking_levels) ? hint.thinking_levels : ["off", "minimal", "low", "medium", "high", "xhigh"]).map((level: string) => [level, level])) } : {}),
      };
    });
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

function materializeRuntimeSettings(agentDir: string, settings: Record<string, any>, config: PiConfig): void {
  const path = join(agentDir, "settings.json");
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
  catch { /* create a scoped runtime settings file */ }
  const contextWindow = positiveInteger(config.model_context_window) ?? positiveInteger(settings.model_context_window);
  const threshold = validThreshold(config.compaction_threshold_percent) ?? validThreshold(settings.compaction_threshold_percent);
  const reserveTokens = contextWindow && threshold
    ? Math.max(1024, Math.round(contextWindow * (1 - threshold / 100)))
    : 16384;
  current.compaction = {
    ...(current.compaction && typeof current.compaction === "object" ? current.compaction as Record<string, unknown> : {}),
    enabled: config.compaction_enabled ?? (settings.compaction_enabled !== false),
    reserveTokens,
    keepRecentTokens: 20000,
  };
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

// Pi appends <agentDir>/APPEND_SYSTEM.md to its system prompt; the frontend
// parses the emitted comment into follow-up suggestion chips.
const FOLLOW_UP_GUIDANCE = "After completing a response, append an HTML comment on the final line: <!--suggest: q1 | q2 | q3--> with up to 3 short, concrete follow-up questions in the user's language. Omit when nothing meaningful remains.\n";

function materializeFollowUpGuidance(agentDir: string): void {
  writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), FOLLOW_UP_GUIDANCE, "utf8");
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function validThreshold(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 50 && parsed <= 95 ? parsed : undefined;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "custom-api";
}
