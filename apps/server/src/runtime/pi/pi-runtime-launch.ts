import { createHash, randomInt, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { PiConfig } from "@pi-science/contracts";
import type { PiProcessOptions, RuntimeSkillPolicy } from "./pi-process.js";
import { configRoot } from "../../storage/persistence.js";
import { canonicalRuntimeModelRef, projectedRuntimeModelRef, projectPiRuntime } from "./pi-runtime-projection.js";

// The Pi Orbit host is a singleton per control plane: one port + one auth
// token are allocated on the first buildPiProcessOptions call and reused by
// every later call. Per-call allocation would grow an ever-unused pool (only
// the first options object actually starts the host) until the pool is
// exhausted and session creation fails hard.
let sharedWebPort: number | null = null;
let sharedWebToken: string | null = null;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const PI_SCIENCE_SYSTEM_PROMPT = join(PROJECT_ROOT, "harness", "AGENTS.md");
/** Outer Pi session variables that describe a Pi process this control plane
 *  does not own (typically the shell that launched the server). They must
 *  never leak into the managed host or its agent runtimes: Pi Orbit resolves
 *  its own per-session values internally, and a leftover value would shadow
 *  the workspace configuration. */
const OUTER_SESSION_ENV_KEYS = ["PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL", "PI_SESSION_ID", "PI_SESSION_FILE"] as const;
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
const NOTEBOOK_EXTENSION = join(
  PROJECT_ROOT,
  "apps",
  "server",
  "src",
  "runtime",
  "pi",
  "extensions",
  "pi-science-notebook.ts",
);
const RESEARCH_EXTENSION = join(
  PROJECT_ROOT,
  "apps",
  "server",
  "src",
  "runtime",
  "pi",
  "extensions",
  "pi-science-research.ts",
);
const MCP_EXTENSION = join(PROJECT_ROOT, "apps", "server", "src", "runtime", "pi", "extensions", "pi-science-mcp.ts");

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

export function buildPiProcessOptions(cwd: string, config?: PiConfig, sessionPath?: string, workspaceEnvironment: NodeJS.ProcessEnv = {}, sessionDirectory?: string): PiProcessOptions | null {
  config ??= { skills: [], extensions: [] };
  const cliPath = process.env.PI_CLI_PATH;
  if (!cliPath) return null;
  const nodePath = process.env.PI_NODE_PATH || process.execPath;
  const dataRoot = configRoot();
  const settings = readSettings(dataRoot);
  const skillPolicy = globalSkillPolicy(settings);
  const configuredModel = config.model ?? (typeof settings.model === "string" ? settings.model : "");
  // The projection decides the runtime provider split and the model aliases.
  // Pass the projected runtime ref to Pi; the canonical ref stays in settings
  // and on the session API.
  const effectiveModel = configuredModel ? projectedRuntimeModelRef(configuredModel) : "";
  const effectiveThinking = config.thinking || (typeof settings.thinking === "string" ? settings.thinking : "high");
  // The workspace model identity the agent can observe through the bash tool
  // environment (PI_PROVIDER/PI_MODEL), derived from the same effectiveModel
  // that is passed via --model. A value without a provider separator is kept
  // as the model id alone; an unset model yields nulls so no stale value can
  // reach the agent.
  const effectiveModelSeparator = effectiveModel.indexOf("/");
  const sessionModelEnv = effectiveModel
    ? effectiveModelSeparator > 0
      ? { PI_PROVIDER: effectiveModel.slice(0, effectiveModelSeparator), PI_MODEL: effectiveModel.slice(effectiveModelSeparator + 1) }
      : { PI_PROVIDER: null, PI_MODEL: effectiveModel }
    : { PI_PROVIDER: null, PI_MODEL: null };
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
  const sessionDir = sessionDirectory ? resolve(sessionDirectory) : join(cwd, ".pi-science", "sessions");
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
  const extensionPaths = ensureMcpExtension(ensureResearchExtension(ensureNotebookExtension(ensureBrowserQuestionnaireAdapter(config.extensions))));
  for (const extension of extensionPaths) args.push("-e", extension);
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
  // The Pi Orbit host and every runtime child inherit this env, so a leftover
  // outer PI_MODEL/PI_PROVIDER/PI_REASONING_LEVEL/PI_SESSION_ID/PI_SESSION_FILE
  // would shadow the workspace configuration passed via CLI args and the
  // runtime descriptor — and the runtime would report the stale outer values
  // to the agent (e.g. "what model are you?"). Remove them from the host env;
  // the runtime boundary below replaces the model variables with the
  // authoritative workspace values and removes the per-session identity that
  // is only known once the runtime exists.
  for (const key of OUTER_SESSION_ENV_KEYS) delete env[key];
  const projection = projectPiRuntime(agentDir, dataRoot, env);
  const projectionKeys = { ...(storedKeys && typeof storedKeys === "object" ? storedKeys as Record<string, unknown> : {}), ...projection.systemApiKeys };
  materializeApiKeysAuth(agentDir, projectionKeys);
  materializeRuntimeSettings(agentDir, settings, config);
  materializeFollowUpGuidance(agentDir);
  // Pi-Science's research contract is an application-level prompt, not a
  // project file. Pass it directly to Pi Orbit while retaining APPEND_SYSTEM
  // guidance that would otherwise be replaced by explicit CLI prompt sources.
  if (existsSync(PI_SCIENCE_SYSTEM_PROMPT)) args.push("--append-system-prompt", PI_SCIENCE_SYSTEM_PROMPT);
  args.push("--append-system-prompt", join(agentDir, "APPEND_SYSTEM.md"));

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
          runtimeEnv: {
            // Runtime-generated credential values must reach the Pi Orbit
            // runtime child: it is created with exactly this env and does not
            // inherit the host process env. models.json references them as
            // $PI_RUNTIME_CREDENTIAL_*, so the values travel with the runtime
            // creation request; the host API never returns runtimeEnv.
            ...runtimeEnvSnapshot(env, projection.runtimeSecrets),
            ...projection.runtimeSecrets,
            // The runtime child inherits the host env, so the host's own auth
            // token must never reach the agent: remove it (null) at the
            // runtime boundary. PI_SESSION_ID/PI_SESSION_FILE only exist once
            // the runtime is live, so they are removed here as well instead of
            // leaking the outer session's values.
            PI_ORBIT_AUTH_TOKEN: null,
            PI_SESSION_ID: null,
            PI_SESSION_FILE: null,
            // The workspace model configuration is the session identity the
            // agent can observe. Pi Orbit resolves per-command
            // PI_PROVIDER/PI_MODEL/PI_REASONING_LEVEL from its own tool
            // context only when that context is wired; in web mode it is not,
            // and a nulled (or outer) value left agents misidentifying the
            // model from unrelated shell variables such as FAST_LLM/SMART_LLM.
            // Publish the effective workspace values instead: they match the
            // --model/--thinking CLI args and the runtime descriptor.
            ...sessionModelEnv,
            ...(effectiveModel ? { PI_REASONING_LEVEL: effectiveThinking } : { PI_REASONING_LEVEL: null }),
          },
          skillPolicy,
        },
      },
    } : {}),
  };
}

function globalSkillPolicy(settings: Record<string, any>): RuntimeSkillPolicy {
  const policy = settings.skill_policy;
  if (!policy || typeof policy !== "object") return { mode: "inherit" };
  if (policy.mode === "inherit" || policy.mode === "none") return { mode: policy.mode };
  if ((policy.mode === "allowlist" || policy.mode === "denylist") && Array.isArray(policy.skills)) {
    const skills = [...new Set((policy.skills as unknown[]).map(String).filter((name): name is string => Boolean(name)))].sort();
    return { mode: policy.mode, skills };
  }
  return { mode: "inherit" };
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
    extensions: ensureResearchExtension(ensureNotebookExtension(ensureBrowserQuestionnaireAdapter(
      Array.isArray(settings.extension_paths)
        ? settings.extension_paths.map(String).filter(Boolean)
        : runtimeExtensionStatus(undefined, runtimeRoots).filter((item) => item.installed && (item.id !== "context-mode" || process.env.PI_SCIENCE_ENABLE_CONTEXT_MODE === "1")).map((item) => item.path!).filter(Boolean),
    ))),
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

/** The notebook tools are a Pi-Science built-in. Keep them in every managed
 * host even when the user configured third-party extensions explicitly; the
 * extension itself remains a thin client of the Node control plane. */
function ensureNotebookExtension(paths: string[]): string[] {
  if (process.env.PI_SCIENCE_DISABLE_NOTEBOOK_TOOLS === "1" || !existsSync(NOTEBOOK_EXTENSION)) return paths;
  return [
    ...paths.filter((path) => path !== NOTEBOOK_EXTENSION),
    NOTEBOOK_EXTENSION,
  ];
}

/** Research handoff tools are globally loaded because Pi Orbit extensions are
 * fixed when the shared host starts. They are side-effect-free; only the Node
 * research runners consume their typed result details. */
function ensureResearchExtension(paths: string[]): string[] {
  if (process.env.PI_SCIENCE_DISABLE_RESEARCH_TOOLS === "1" || !existsSync(RESEARCH_EXTENSION)) return paths;
  return [...paths.filter((path) => path !== RESEARCH_EXTENSION), RESEARCH_EXTENSION];
}

/** MCP is always loaded through Pi-Science's programmatic snapshot adapter.
 * This prevents pi-mcp-adapter from merging ambient global/project files. */
function ensureMcpExtension(paths: string[]): string[] {
  if (process.env.PI_SCIENCE_DISABLE_MCP === "1" || !existsSync(MCP_EXTENSION)) return paths;
  return [...paths.filter((path) => path !== MCP_EXTENSION && !path.includes("pi-mcp-adapter")), MCP_EXTENSION];
}

function readSettings(dataRoot: string): Record<string, any> {
  try { return JSON.parse(readFileSync(join(resolve(dataRoot), "config.json"), "utf8")) as Record<string, any>; }
  catch { return {}; }
}

/** Write Pi-Science API keys into the managed Pi agent dir's auth.json so
 *  EVERY pi-ai provider (including OpenCode Go, Kimi, Qwen, ...) reads them.
 *  The managed dir is Pi-Science-owned, but an existing auth.json may carry
 *  OAuth/other entries from direct pi usage: non-api_key entries are
 *  preserved untouched; api_key entries are Pi-Science-managed, so settings
 *  is the authority and stale removed keys are dropped. File mode 0600. */
function materializeApiKeysAuth(agentDir: string, storedKeys: Record<string, unknown>): void {
  const path = join(agentDir, "auth.json");
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
  catch { /* fresh auth file */ }
  const next: Record<string, unknown> = {};
  for (const [provider, entry] of Object.entries(current)) {
    if (!entry || typeof entry !== "object") continue;
    const kind = (entry as Record<string, unknown>).type;
    if (kind !== "api_key") { next[provider] = entry; continue; }
    const stillConfigured = typeof storedKeys[provider] === "string" && storedKeys[provider] !== "";
    if (stillConfigured) next[provider] = entry;
  }
  for (const [provider, key] of Object.entries(storedKeys)) {
    if (typeof key !== "string" || !key) continue;
    next[provider] = { type: "api_key", key };
  }
  if (Object.keys(next).length === 0) {
    try { unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return;
  }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  try { chmodSync(path, 0o600); } catch { /* permissions are best-effort (e.g. Windows) */ }
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

// Multi-step work guidance: nudge (never hard-block) complex tasks into the
// todo tool so progress survives restarts and is visible in the app.
const TODO_GUIDANCE = "Workflow planning: when a request requires multiple independent steps, several file edits, a research loop, notebook analysis, or repeated tool calls, first call the todo tool (action: create) to lay out the task list. Keep exactly one task in_progress at a time, update tasks as steps complete (or when the plan changes), and mark every task completed (or cancelled/deferred) before finishing. Simple single-step requests do not need a todo list.\n";

function materializeFollowUpGuidance(agentDir: string): void {
  writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), `${FOLLOW_UP_GUIDANCE}${TODO_GUIDANCE}`, "utf8");
}

function runtimeEnvSnapshot(env: NodeJS.ProcessEnv, generatedSecrets: Record<string, string>): Record<string, string | null> {
  const isSecretName = (key: string): boolean => Object.hasOwn(generatedSecrets, key) || /(?:API_KEY|TOKEN|PASSWORD|SECRET|PRIVATE_KEY)$/i.test(key);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isSecretName(key)).map(([key, value]) => [key, value ?? null]));
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function validThreshold(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 50 && parsed <= 95 ? parsed : undefined;
}
