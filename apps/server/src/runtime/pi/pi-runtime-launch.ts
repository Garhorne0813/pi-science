import { createHash, randomInt, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { PiConfig } from "@pi-science/contracts";
import type { PiProcessOptions } from "./pi-process.js";
import { configRoot } from "../../storage/persistence.js";

// The Pi Orbit host is a singleton per control plane: one port + one auth
// token are allocated on the first buildPiProcessOptions call and reused by
// every later call. Per-call allocation would grow an ever-unused pool (only
// the first options object actually starts the host) until the pool is
// exhausted and session creation fails hard.
let sharedWebPort: number | null = null;
let sharedWebToken: string | null = null;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const BROWSER_QUESTIONNAIRE_ADAPTER = join(
  PROJECT_ROOT,
  "apps",
  "server",
  "src",
  "runtime",
  "pi",
  "extensions",
  "pi-science-ask-user-question-web.ts",
);

function webPort(): number {
  if (sharedWebPort === null) sharedWebPort = randomInt(20_000, 60_000);
  return sharedWebPort;
}

function webAuthToken(): string {
  if (sharedWebToken === null) sharedWebToken = randomUUID();
  return sharedWebToken;
}

/** Forget the shared port/token so the next call allocates fresh values.
 *  Called after a host start failure (e.g. EADDRINUSE: the single port is
 *  taken by another process) so the next attempt picks a new port and can
 *  self-heal without a control-plane restart. */
export function resetWebRuntimeAllocation(): void {
  sharedWebPort = null;
  sharedWebToken = null;
}

export function buildPiProcessOptions(cwd: string, config: PiConfig = { skills: [], extensions: [] }, sessionPath?: string, workspaceEnvironment: NodeJS.ProcessEnv = {}): PiProcessOptions | null {
  const cliPath = process.env.PI_CLI_PATH;
  if (!cliPath) return null;
  const nodePath = process.env.PI_NODE_PATH || process.execPath;
  const dataRoot = configRoot();
  const settings = readSettings(dataRoot);
  const effectiveModel = config.model || (typeof settings.model === "string" ? settings.model : "");
  const effectiveThinking = config.thinking || (typeof settings.thinking === "string" ? settings.thinking : "high");
  const args: string[] = [];
  let command = nodePath;
  const useRpcMode = process.env.PI_SCIENCE_PI_MODE === "rpc";
  const reservedWebPort = useRpcMode ? 0 : webPort();
  const reservedWebToken = useRpcMode ? "" : webAuthToken();
  const seededSkills = seedWorkspaceAssets(cwd);
  if (cliPath.endsWith(".ts")) {
    const tsxPath = process.env.PI_TSX_PATH || findAdjacentRuntime(cliPath, join("node_modules", ".bin", "tsx"));
    if (!tsxPath) throw new Error(`TypeScript Pi CLI requires tsx: ${cliPath}`);
    args.push(tsxPath);
    if (process.env.PI_TSCONFIG_PATH) args.push("--tsconfig", process.env.PI_TSCONFIG_PATH);
    args.push(cliPath);
  } else if (/\.[cm]?js$/i.test(cliPath)) {
    args.push(cliPath);
  } else {
    command = cliPath;
  }
  const sessionDir = join(cwd, ".pi-science", "sessions");
  args.push("--mode", useRpcMode ? "rpc" : "web");
  if (useRpcMode) args.push("--session-dir", sessionDir);
  else args.push("--host", "127.0.0.1", "--port", String(reservedWebPort), "--web-app-managed", "--no-session");
  // Pi Science workspaces own their .pi/skills/ resources; trust them by
  // default so project-built-in skills are available to the managed runtime.
  args.push("--approve");
  args.push("--no-extensions");
  if (effectiveModel) args.push("--model", effectiveModel);
  if (effectiveThinking) args.push("--thinking", effectiveThinking);
  if (useRpcMode && sessionPath) args.push("--session", sessionPath);
  for (const skill of useRpcMode ? [...seededSkills, ...config.skills] : config.skills) args.push("--skill", skill);
  for (const extension of ensureBrowserQuestionnaireAdapter(config.extensions)) args.push("-e", extension);
  const workspaceKey = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12);
  let agentDir = join(dataRoot, "pi-agent", useRpcMode ? workspaceKey : "web-host");
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
    ...(!useRpcMode ? { PI_ORBIT_AUTH_TOKEN: reservedWebToken } : {}),
    ...(!useRpcMode ? {
      PI_ORBIT_MAX_RUNTIMES: process.env.PI_ORBIT_MAX_RUNTIMES ?? "256",
      PI_ORBIT_MAX_CONCURRENT_TURNS: process.env.PI_ORBIT_MAX_CONCURRENT_TURNS ?? "16",
      PI_ORBIT_IDLE_TIMEOUT_MS: process.env.PI_ORBIT_IDLE_TIMEOUT_MS ?? String(24 * 60 * 60_000),
    } : {}),
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
    command,
    args,
    env,
    ...(!useRpcMode ? {
      web: {
        baseUrl: `http://127.0.0.1:${reservedWebPort}`,
        authToken: reservedWebToken,
        runtime: {
          cwd: resolve(cwd),
          sessionDir,
          ...(sessionPath ? { sessionPath } : {}),
          ...(effectiveModel ? { model: effectiveModel } : {}),
          ...(effectiveModel && effectiveThinking ? { thinking: effectiveThinking } : {}),
          runtimeEnv: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value ?? null])),
        },
      },
    } : {}),
  };
}

export function seedWorkspaceAssets(cwd: string): string[] {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
  // The workspace metadata dirs are managed state. A symlink (or plain file)
  // left at cwd/.pi or cwd/.pi-science would make every write below (skills
  // mirror, stale cleanup) land inside — and delete from — the linked
  // location, so replace foreign entries before any mkdir/cp runs.
  replaceForeignEntry(join(cwd, ".pi-science"));
  replaceForeignEntry(join(cwd, ".pi"));
  const metadata = join(cwd, ".pi-science");
  mkdirSync(metadata, { recursive: true });
  const agents = join(cwd, "AGENTS.md");
  const sourceAgents = join(projectRoot, "harness", "AGENTS.md");
  if (existsSync(sourceAgents)) {
    // A dangling (or external-pointing) AGENTS.md symlink makes existsSync
    // report "missing" while cpSync still targets the link: the write aborts
    // with a C++ exception (exit 134) or lands outside the workspace. Drop
    // any symlink/non-file placeholder before deciding whether to seed.
    removeUnlinkable(agents);
    if (!existsSync(agents)) cpSync(sourceAgents, agents);
  }
  const sourceSkills = join(projectRoot, "skills");
  const targetSkills = join(cwd, ".pi", "skills");
  // The .pi/skills tree is managed state: if a previous seed or the runtime
  // left a symlink (or plain file) here, remove it first. Never seed through
  // a symlink — it would write to and delete from wherever the link points.
  replaceForeignEntry(targetSkills);
  mkdirSync(targetSkills, { recursive: true });
  const result: string[] = [];
  // The packaged checkout may ship without a skills/ directory (source-only
  // archives). Missing project skills must not break session creation.
  if (!existsSync(sourceSkills)) return result;
  for (const name of readdirSync(sourceSkills, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const skillMarkdown = join(sourceSkills, name.name, "SKILL.md");
    let skillMdInfo;
    try {
      skillMdInfo = lstatSync(skillMarkdown);
    } catch {
      continue;
    }
    // Refuse to seed from a symlinked SKILL.md; only real files count.
    if (!skillMdInfo.isFile()) continue;
    const source = join(sourceSkills, name.name);
    const target = join(targetSkills, name.name);
    seedSkillTree(source, target);
    result.push(target);
  }
  return result;
}

// Remove a symlink or non-directory blocking a managed directory path so
// mkdirSync/cpSync below never follows or collides with a foreign entry.
function replaceForeignEntry(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    rmSync(path, { recursive: true, force: true });
  }
}

// Mirror a builtin skill into the workspace .pi/skills/ tree. Copies the
// whole directory (SKILL.md plus helpers, references, assets, and requirement
// manifests) so scripted skills work offline; refuses symlinks and anything
// escaping the skill directory; and removes stale entries that no longer
// exist upstream so removed helpers cannot linger in workspaces.
function seedSkillTree(source: string, target: string): void {
  // The tree root is managed state: a symlink (or file) left here by a
  // previous seed or the runtime is removed before anything is written —
  // never write through it, and never let stale-entry cleanup delete from
  // wherever it points.
  replaceForeignEntry(target);
  mkdirSync(target, { recursive: true });
  const pending: Array<{ source: string; target: string }> = [{ source, target }];
  while (pending.length > 0) {
    const { source: from, target: to } = pending.pop()!;
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.name === "." || entry.name === "..") continue;
      const fromPath = join(from, entry.name);
      const toPath = join(to, entry.name);
      // Never follow symlinks from the skill tree, and never write through a
      // symlink that a previous seed or the runtime may have left behind.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // Directory entries are written later (children), so guard the target
        // now: a stale symlink here would let later writes leak outside, and
        // a foreign file would break directory creation with ENOTDIR.
        let info;
        try {
          info = lstatSync(toPath);
        } catch {
          /* missing: fine */
        }
        if (info && (info.isSymbolicLink() || !info.isDirectory())) {
          rmSync(toPath, { recursive: true, force: true });
        }
        pending.push({ source: fromPath, target: toPath });
      } else if (entry.isFile()) {
        removeUnlinkable(toPath);
        cpSync(fromPath, toPath);
      }
    }
  }
  removeStaleEntries(source, target);
}

// Remove a symlink or a directory in the way of an incoming file (and a file
// in the way of an incoming directory, handled by the recursive rm below) so
// cpSync never follows or collides with a foreign entry.
function removeUnlinkable(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink() || info.isDirectory()) rmSync(path, { recursive: true, force: true });
}

function removeStaleEntries(source: string, target: string): void {
  let entries: string[];
  try {
    entries = readdirSync(target);
  } catch {
    return;
  }
  for (const name of entries) {
    const sourcePath = join(source, name);
    const targetPath = join(target, name);
    let targetInfo;
    try {
      targetInfo = lstatSync(targetPath);
    } catch {
      continue;
    }
    if (targetInfo.isSymbolicLink()) {
      console.warn(`[pi-science] removing stale seeded entry: ${targetPath} (foreign symlink)`);
      rmSync(targetPath, { recursive: true, force: true });
      continue;
    }
    let sourceInfo;
    try {
      sourceInfo = statSync(sourcePath);
    } catch {
      // No upstream counterpart: the entry is stale (or the upstream tree
      // changed shape), so drop it to keep the mirror exact.
      console.warn(`[pi-science] removing stale seeded entry: ${targetPath} (no upstream counterpart)`);
      rmSync(targetPath, { recursive: true, force: true });
      continue;
    }
    if (targetInfo.isDirectory() && sourceInfo.isDirectory()) {
      removeStaleEntries(sourcePath, targetPath);
    } else if (targetInfo.isDirectory() !== sourceInfo.isDirectory()) {
      console.warn(`[pi-science] removing stale seeded entry: ${targetPath} (type mismatch with upstream)`);
      rmSync(targetPath, { recursive: true, force: true });
    }
  }
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

export function loadDefaultPiConfig(runtimeRoots?: string[]): PiConfig {
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
    extensions: ensureBrowserQuestionnaireAdapter(
      Array.isArray(settings.extension_paths)
        ? settings.extension_paths.map(String).filter(Boolean)
        : runtimeExtensionStatus(undefined, runtimeRoots).filter((item) => item.installed && (item.id !== "context-mode" || process.env.PI_SCIENCE_ENABLE_CONTEXT_MODE === "1")).map((item) => item.path!).filter(Boolean),
    ),
  };
}

const EXTENSIONS = [
  { id: "pi-mcp-adapter", name: "MCP Adapter", description: "Bridges configured MCP servers into Pi." },
  { id: "pi-subagents", name: "Subagents", description: "Adds focused scientific subagents." },
  { id: "pi-web-access", name: "Web Access", description: "Adds web search, URL fetching, and media extraction." },
  { id: "context-mode", name: "Context Mode", description: "Optional sandboxed context index.", entrypoints: ["build/adapters/pi/extension.js"] },
  { id: "rpiv-ask-user-question", packageName: "@juicesharp/rpiv-ask-user-question", name: "Ask User Question", description: "Adds structured multi-question prompts with previews, multi-select, custom answers, and notes." },
  { id: "rpiv-todo", packageName: "@juicesharp/rpiv-todo", name: "Todo", description: "Adds task tracking with a live overlay." },
] as const;

export function runtimeExtensionStatus(cliPath = process.env.PI_CLI_PATH ?? "", overrideRoots?: string[]): Array<{ id: string; name: string; description: string; installed: boolean; path: string | null }> {
  return EXTENSIONS.map((extension) => {
    const packageName = "packageName" in extension ? extension.packageName : extension.id;
    const path = findRuntimeExtension(packageName, cliPath, "entrypoints" in extension ? [...extension.entrypoints] : [], overrideRoots);
    return { id: extension.id, name: extension.name, description: extension.description, installed: Boolean(path), path };
  });
}

function findRuntimeExtension(packageName: string, cliPath: string, extraEntrypoints: string[], overrideRoots?: string[]): string | null {
  if (!cliPath) return null;
  const roots: string[] = [];
  if (overrideRoots) {
    // Test/injection hook: use exactly the supplied roots so a managed
    // runtime checkout elsewhere cannot shadow the scenario under test.
    roots.push(...overrideRoots);
  } else {
    let current = dirname(resolve(cliPath));
    for (let depth = 0; depth < 12; depth += 1) {
      if (!roots.includes(current)) roots.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    // Prefer extensions published alongside the selected CLI. The managed
    // runtime is a fallback for the bundled release, but must not shadow a
    // manifest-discovered extension from an explicitly selected installation.
    const managedRuntimeRoot = join(PROJECT_ROOT, "runtime", "pi");
    if (existsSync(managedRuntimeRoot) && !roots.includes(managedRuntimeRoot)) roots.push(managedRuntimeRoot);
    const managedPiInstallRoot = join(homedir(), ".pi", "agent", "npm");
    if (!roots.includes(managedPiInstallRoot)) roots.push(managedPiInstallRoot);
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

/**
 * Pi keeps the first registration for a tool name. Put the Pi-Science browser
 * bridge before the upstream package whenever that package is present, while
 * leaving manually configured extension lists untouched unless they include
 * the questionnaire package itself.
 */
function ensureBrowserQuestionnaireAdapter(paths: string[]): string[] {
  if (!existsSync(BROWSER_QUESTIONNAIRE_ADAPTER)) return paths;
  const hasQuestionnairePackage = paths.some((path) => path.includes("rpiv-ask-user-question"));
  if (!hasQuestionnairePackage) return paths;
  // Pi rejects duplicate tool registrations instead of applying a last-wins
  // rule. The browser bridge implements the same public tool contract, so the
  // upstream package is installed for native Pi hosts but omitted from this
  // managed Web/RPC process when the bridge is active.
  return [
    BROWSER_QUESTIONNAIRE_ADAPTER,
    ...paths.filter((path) => path !== BROWSER_QUESTIONNAIRE_ADAPTER && !path.includes("rpiv-ask-user-question")),
  ];
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
const FOLLOW_UP_GUIDANCE = "After completing a response, append an HTML comment on the final line: <!--suggest: q1 | q2 | q3--> with up to 3 short, concrete follow-up suggestions. Each suggestion must be a standalone message the user can copy and send directly, written from the user's perspective as a request, question, or imperative (for example, Chinese: 请比较… / 继续分析… / 帮我…; English: Compare… / Please analyze…). Do not use assistant/agent-offering language such as 我可以… / 要不要我… / I can… / Would you like me to…, and do not address the user as 你 or you when describing the agent's next step. Use the user's language, and omit the comment when no meaningful follow-up remains.\n";

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
