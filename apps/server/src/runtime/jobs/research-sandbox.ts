import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { tmpdir } from "node:os";
import { configRoot, legacyMetadataRoot, metadataRoot } from "../../storage/persistence.js";

export type ResearchSandboxBackend = "seatbelt" | "bubblewrap" | "appcontainer";
export type ResearchSandboxStatus = { available: true; backend: ResearchSandboxBackend } | { available: false; reason: string };

export const WINDOWS_CONVERSATION_UNAVAILABLE =
  "Conversation execution is unavailable on Windows because the current AppContainer sandbox cannot exclude the reserved .pi-science workspace path from a writable workspace";

const macSystemRoots = ["/usr", "/bin", "/sbin", "/System", "/Library", "/opt", "/private/etc"];
const linuxSystemRoots = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"];

function inside(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function quote(value: string): string { return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`; }

function parents(path: string): string[] {
  const result: string[] = [];
  for (let current = resolve(path); current !== resolve(current, ".."); current = resolve(current, "..")) result.push(current);
  result.push(resolve(path, "/"));
  return result;
}

function macProfile(readable: string[], writable: string[], denied: string[] = []): string {
  const ancestorRules = [...new Set([...readable, ...writable].flatMap(parents))].map((path) => `(literal ${quote(path)})`);
  const readRules = [...new Set(readable)].flatMap((path) => [`(literal ${quote(path)})`, `(subpath ${quote(path)})`]);
  const writeRules = [...new Set(writable)].map((path) => `(subpath ${quote(path)})`);
  return [
    "(version 1)", "(deny default)",
    "(allow process-exec)", "(allow process-fork)",
    "(allow process-info* (target same-sandbox))", "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.libinfo\") (global-name \"com.apple.system.opendirectoryd.membership\") (global-name \"com.apple.logd\"))",
    `(allow file-read* ${[...ancestorRules, ...readRules].join(" ")})`,
    `(allow file-write* ${writeRules.join(" ")})`,
    ...denied.map((path) => `(deny file-read* file-write* (literal ${quote(path)}) (subpath ${quote(path)}))`),
  ].join("\n");
}

function availableSystemRoots(roots: string[]): string[] { return roots.filter(existsSync); }

async function selectedNodeReadPaths(workspace: string): Promise<string[]> {
  const selected = process.env.PI_NODE_PATH;
  if (!selected || !isAbsolute(selected)) return [];
  const canonical = await realpath(selected).catch(() => null);
  const running = await realpath(process.execPath).catch(() => null);
  if (!canonical || canonical !== running || inside(workspace, canonical)) return [];
  if (!(await lstat(canonical)).isFile()) return [];
  const nvmRoot = await realpath(process.env.NVM_DIR ?? join(process.env.HOME ?? "", ".nvm")).catch(() => null);
  const versionRoot = nvmRoot ? join(nvmRoot, "versions", "node") : null;
  if (versionRoot && inside(versionRoot, canonical) && dirname(canonical).endsWith(`${sep}bin`)) {
    return [dirname(canonical)];
  }
  return [canonical];
}

function sandyExecutable(): string { return process.env.PI_SCIENCE_SANDY_PATH ?? ""; }

function windowsRuntimeReadRoot(commandPath: string): string | null {
  const normalized = win32.resolve(commandPath).toLowerCase();
  const systemRoots = [process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
    .filter((path): path is string => Boolean(path)).map((path) => win32.resolve(path).toLowerCase());
  if (systemRoots.some((root) => normalized === root || normalized.startsWith(`${root}\\`))) return null;
  const parent = win32.dirname(commandPath);
  // Git for Windows bash loads DLLs and helpers from sibling bin/mingw64/usr
  // directories. Grant its installation root, never the whole user profile.
  const gitRoot = normalized.match(/^(.*\\git)\\(?:usr\\)?bin\\bash\.exe$/);
  return gitRoot ? commandPath.slice(0, gitRoot[1]!.length) : parent;
}

function tomlString(value: string): string { return JSON.stringify(value); }

function tomlArray(values: string[]): string { return `[${[...new Set(values)].map(tomlString).join(", ")}]`; }

function windowsAncestorDirectories(paths: string[]): string[] {
  const result = new Map<string, string>();
  for (const path of paths) {
    const resolved = win32.resolve(path);
    const root = win32.parse(resolved).root;
    for (let current = win32.dirname(resolved);; current = win32.dirname(current)) {
      result.set(current.toLowerCase(), current);
      if (current.toLowerCase() === root.toLowerCase()) break;
    }
  }
  return [...result.values()];
}

function windowsInside(root: string, target: string): boolean {
  const path = win32.relative(win32.resolve(root), win32.resolve(target));
  return path === "" || (!win32.isAbsolute(path) && path !== ".." && !path.startsWith(`..${win32.sep}`));
}

/** Sandy uses a per-run AppContainer SID and a Job Object; no restricted-token fallback. */
export function windowsResearchSandboxConfig(input: { commandPath: string; executionCwd: string; readable: string[]; writable: string[]; executableRoots?: string[]; timeoutSeconds?: number }): string {
  const runtimeRoot = windowsRuntimeReadRoot(input.commandPath);
  const executableRoots = [runtimeRoot, ...(input.executableRoots ?? [])].filter((path): path is string => Boolean(path));
  const ancestorDirectories = windowsAncestorDirectories([...executableRoots, ...input.readable, ...input.writable]);
  const readableOnly = input.readable.filter((path) => ![...executableRoots, ...input.writable].some((root) => windowsInside(root, path)));
  return [
    "[sandbox]",
    "token = 'appcontainer'",
    `workdir = ${tomlString(input.executionCwd)}`,
    "[allow.deep]",
    `execute = ${tomlArray(executableRoots)}`,
    `read = ${tomlArray(readableOnly)}`,
    `all = ${tomlArray(input.writable)}`,
    "[allow.this]",
    `read = ${tomlArray(ancestorDirectories)}`,
    "[privileges]",
    "network = false",
    "lan = false",
    "stdin = false",
    "clipboard_read = false",
    "clipboard_write = false",
    "child_processes = true",
    "[environment]",
    "inherit = true",
    "[limit]",
    ...(input.timeoutSeconds ? [`timeout = ${Math.max(1, Math.floor(input.timeoutSeconds))}`] : []),
    "memory = 4096",
    "processes = 64",
  ].join("\n");
}

function bwrapCommand(command: string[], readable: string[], writable: string[], cwd = "/", hidden: Array<{ source: string; target: string }> = []): string[] {
  const args = ["--unshare-user", "--disable-userns", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net", "--new-session", "--die-with-parent", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
  for (const path of [...new Set(readable)]) args.push("--ro-bind", path, path);
  for (const path of [...new Set(writable)]) args.push("--bind", path, path);
  for (const { source, target } of hidden) args.push("--ro-bind", source, target);
  return ["bwrap", ...args, "--chdir", cwd, "--", ...command];
}

export function researchSandboxStatus(platform: NodeJS.Platform = process.platform): ResearchSandboxStatus {
  if (platform === "darwin") {
    const binary = "/usr/bin/sandbox-exec";
    if (!existsSync(binary)) return { available: false, reason: "sandbox-exec is not installed" };
    const profile = macProfile(availableSystemRoots(macSystemRoots), []);
    const probe = spawnSync(binary, ["-p", profile, "/usr/bin/true"], { timeout: 5_000, encoding: "utf8" });
    return probe.status === 0 ? { available: true, backend: "seatbelt" } : { available: false, reason: `sandbox-exec probe failed: ${probe.error?.message ?? probe.stderr?.trim() ?? probe.status}` };
  }
  if (platform === "linux") {
    const probe = spawnSync("bwrap", bwrapCommand(["/usr/bin/true"], availableSystemRoots(linuxSystemRoots), [] ).slice(1), { timeout: 5_000, encoding: "utf8" });
    return probe.status === 0 ? { available: true, backend: "bubblewrap" } : { available: false, reason: `bubblewrap probe failed: ${probe.error?.message ?? probe.stderr?.trim() ?? probe.status}` };
  }
  if (platform === "win32") {
    const binary = sandyExecutable();
    if (!isAbsolute(binary) || !binary.toLowerCase().endsWith(".exe")) return { available: false, reason: "set PI_SCIENCE_SANDY_PATH to an absolute sandy.exe path" };
    const probe = spawnSync(binary, ["--version"], { timeout: 5_000, encoding: "utf8", windowsHide: true });
    return probe.status === 0 ? { available: true, backend: "appcontainer" } : { available: false, reason: `Sandy AppContainer runner is unavailable: ${probe.error?.message ?? probe.stderr?.trim() ?? probe.status}. Install sandy.exe or set PI_SCIENCE_SANDY_PATH` };
  }
  return { available: false, reason: `local research sandbox is unavailable on ${platform}` };
}

const statusCache = new Map<string, { expires: number; value: ResearchSandboxStatus }>();
const pendingStatus = new Map<string, Promise<ResearchSandboxStatus>>();
const STATUS_TTL_MS = 60_000;

export function probeAsync(binary: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ status: number | null; error?: string; stderr: string }> {
  return new Promise((resolveProbe) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], cwd: options.cwd, env: options.env });
    let stderr = "";
    let error: string | undefined;
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1000); });
    child.on("error", (cause: Error) => { error = cause.message; });
    const timer = setTimeout(() => { error = `timed out after ${options.timeoutMs ?? 5_000} ms`; child.kill(); }, options.timeoutMs ?? 5_000);
    child.on("close", (status) => { clearTimeout(timer); resolveProbe({ status, error, stderr: stderr.trim() }); });
  });
}

function probeFailure(result: { status: number | null; error?: string; stderr: string }): string {
  return result.error || result.stderr || String(result.status);
}

/** Nonblocking status for control-plane reads and execution preflight. */
export async function cachedResearchSandboxStatus(platform: NodeJS.Platform = process.platform): Promise<ResearchSandboxStatus> {
  const key = `${platform}:${platform === "win32" ? sandyExecutable() : ""}`;
  const cached = statusCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const inFlight = pendingStatus.get(key);
  if (inFlight) return inFlight;
  const promise = (async (): Promise<ResearchSandboxStatus> => {
    if (platform === "darwin") {
      if (!existsSync("/usr/bin/sandbox-exec")) return { available: false, reason: "sandbox-exec is not installed" };
      const result = await probeAsync("/usr/bin/sandbox-exec", ["-p", macProfile(availableSystemRoots(macSystemRoots), []), "/usr/bin/true"]);
      return result.status === 0 && !result.error ? { available: true, backend: "seatbelt" } : { available: false, reason: `sandbox-exec probe failed: ${probeFailure(result)}` };
    }
    if (platform === "linux") {
      const result = await probeAsync("bwrap", bwrapCommand(["/usr/bin/true"], availableSystemRoots(linuxSystemRoots), []).slice(1));
      return result.status === 0 && !result.error ? { available: true, backend: "bubblewrap" } : { available: false, reason: `bubblewrap probe failed: ${probeFailure(result)}` };
    }
    if (platform === "win32") {
      const binary = sandyExecutable();
      if (!isAbsolute(binary) || !binary.toLowerCase().endsWith(".exe")) return { available: false, reason: "set PI_SCIENCE_SANDY_PATH to an absolute sandy.exe path" };
      const result = await probeAsync(binary, ["--version"]);
      return result.status === 0 && !result.error ? { available: true, backend: "appcontainer" } : { available: false, reason: `Sandy AppContainer runner is unavailable: ${probeFailure(result)}. Install sandy.exe or set PI_SCIENCE_SANDY_PATH` };
    }
    return { available: false, reason: `local research sandbox is unavailable on ${platform}` };
  })();
  pendingStatus.set(key, promise);
  try {
    const value = await promise;
    statusCache.set(key, { value, expires: Date.now() + STATUS_TTL_MS });
    return value;
  } finally { pendingStatus.delete(key); }
}

export async function sandboxResearchCommand(input: { command: string[]; workspace: string; executionCwd: string; surface: string; environment: NodeJS.ProcessEnv; managedEnvironmentPrefix?: string; timeoutSeconds?: number; platform?: NodeJS.Platform }): Promise<{ command: string[]; environment: NodeJS.ProcessEnv; backend: ResearchSandboxBackend }> {
  const status = await cachedResearchSandboxStatus(input.platform);
  if (!status.available) throw new Error(`research execution isolation unavailable: ${status.reason}`);
  const workspace = await realpath(input.workspace);
  if (status.backend === "appcontainer") {
    const launcher = await realpath(sandyExecutable());
    if (inside(workspace, launcher)) throw new Error("research AppContainer launcher must be outside the workspace");
    // taskkill may terminate the broker before it can restore transient ACLs.
    // Sandy records those grants and repairs only stale instances on cleanup.
    const cleanup = await probeAsync(sandyExecutable(), ["--cleanup"], { timeoutMs: 10_000 });
    if (cleanup.status !== 0 || cleanup.error) throw new Error(`research AppContainer cleanup failed: ${probeFailure(cleanup)}`);
  }
  const runs = await realpath(join(metadataRoot(workspace), "runs"));
  if (!inside(metadataRoot(workspace), runs)) throw new Error("research run root escapes the workspace state directory");
  const requestedWorkspace = resolve(input.workspace);
  const requestedExecutionCwd = resolve(input.executionCwd);
  const requestedState = resolve(metadataRoot(requestedWorkspace));
  if (requestedExecutionCwd !== requestedWorkspace && !inside(requestedState, requestedExecutionCwd)) throw new Error("research execution directory escapes the workspace state directory");
  const candidate = input.surface === "research-loop";
  const evaluator = input.surface === "research-evaluator";
  if (!candidate && !evaluator) throw new Error("unsupported research sandbox surface");
  const outputValue = candidate ? input.environment.PI_SCIENCE_OUTPUT_DIR : input.environment.PI_SCIENCE_EVALUATION_PATH;
  if (!outputValue || !isAbsolute(outputValue)) throw new Error("research sandbox output path is missing");
  const requestedOutputDirectory = resolve(candidate ? outputValue : resolve(outputValue, ".."));
  if (candidate && requestedExecutionCwd !== resolve(requestedOutputDirectory, "..", "work")) throw new Error("candidate work directory is not beside its output directory");
  if (evaluator && requestedExecutionCwd !== requestedWorkspace && requestedExecutionCwd !== requestedOutputDirectory) throw new Error("evaluator work directory is not its output directory");
  const outputDirectory = await realpath(requestedOutputDirectory);
  if (!outputDirectory.startsWith(`${runs}${sep}`)) throw new Error("research sandbox output escapes the run directory");
  const executionCwd = candidate ? await realpath(resolve(outputDirectory, "..", "work")) : requestedExecutionCwd === requestedWorkspace ? workspace : outputDirectory;
  if (executionCwd !== workspace && !executionCwd.startsWith(`${runs}${sep}`)) throw new Error("research execution directory escapes the run directory");
  if (candidate && (!inside(runs, executionCwd) || !executionCwd.endsWith(`${sep}work`))) throw new Error("candidate work directory is invalid");
  if (evaluator && executionCwd !== workspace && (!inside(runs, executionCwd) || !executionCwd.endsWith(`${sep}evaluator`))) throw new Error("evaluator work directory is invalid");
  if (candidate && resolve(outputDirectory, "..") !== resolve(executionCwd, "..")) throw new Error("candidate output is not beside its work directory");
  if (evaluator && executionCwd !== workspace && outputDirectory !== executionCwd) throw new Error("evaluator result is not in its work directory");
  const commandPath = await realpath(input.command[0]!);
  if (candidate && inside(workspace, commandPath) && !inside(executionCwd, commandPath)) throw new Error("candidate executable escapes its work directory");
  const commandRuntimeRoot = status.backend === "appcontainer" ? windowsRuntimeReadRoot(commandPath) : null;
  if (candidate && commandRuntimeRoot && inside(commandRuntimeRoot, workspace) && !inside(executionCwd, commandRuntimeRoot)) throw new Error("candidate executable grant would expose the workspace");
  // macOS exposes /var as a symlink to /private/var. Seatbelt may evaluate
  // either spelling, so grant both the validated canonical and original path.
  const originalOutput = resolve(candidate ? outputValue : resolve(outputValue, ".."));
  const aliases = status.backend === "seatbelt";
  const readable = [...(status.backend === "appcontainer" ? [] : availableSystemRoots(aliases ? macSystemRoots : linuxSystemRoots)), ...(status.backend === "appcontainer" ? [] : [commandPath]), ...(aliases ? [input.command[0]!] : []), ...(candidate ? [executionCwd, outputDirectory] : [workspace, outputDirectory]), ...(aliases ? candidate ? [input.executionCwd, originalOutput] : [input.workspace, originalOutput] : [])];
  if (status.backend !== "appcontainer") readable.push(...await selectedNodeReadPaths(workspace));
  const writable = candidate ? [executionCwd, outputDirectory, ...(aliases ? [input.executionCwd, originalOutput] : [])] : [outputDirectory, ...(aliases ? [originalOutput] : [])];
  if (evaluator) {
    const requestedSubject = input.environment.PI_SCIENCE_SUBJECT_DIR;
    if (requestedSubject) {
      if (!isAbsolute(requestedSubject)) throw new Error("research evaluator subject path is not absolute");
      const subject = await realpath(requestedSubject);
      if (subject !== workspace && !inside(runs, subject)) throw new Error("research evaluator subject escapes the workspace and run directory");
      readable.push(subject);
      if (aliases) readable.push(requestedSubject);
    }
    const evaluatorRoot = await realpath(join(metadataRoot(workspace), "evaluators")).catch(() => join(metadataRoot(workspace), "evaluators"));
    for (const argument of input.command.slice(1)) {
      if (!isAbsolute(argument)) continue;
      const path = await realpath(argument).catch(() => null);
      if (path && inside(evaluatorRoot, path)) readable.push(path);
    }
  }
  const executableRoots: string[] = [];
  if (status.backend === "appcontainer") {
    const nodeRuntimeRoot = windowsRuntimeReadRoot(process.execPath);
    if (nodeRuntimeRoot && (!candidate || (!inside(workspace, nodeRuntimeRoot) && !inside(nodeRuntimeRoot, workspace)))) executableRoots.push(nodeRuntimeRoot);
  }
  if (input.managedEnvironmentPrefix) {
    const environmentRoot = await realpath(join(configRoot(), "micromamba", "envs"));
    const prefix = await realpath(input.managedEnvironmentPrefix);
    if (prefix === environmentRoot || !inside(environmentRoot, prefix) || !(await lstat(prefix)).isDirectory()) throw new Error("managed research environment prefix is outside the approved environment root");
    readable.push(prefix);
    if (status.backend === "appcontainer") executableRoots.push(prefix);
    if (aliases) readable.push(input.managedEnvironmentPrefix);
  }
  const environment: NodeJS.ProcessEnv = { ...input.environment, HOME: outputDirectory, TMPDIR: join(outputDirectory, ".tmp"), TMP: join(outputDirectory, ".tmp"), TEMP: join(outputDirectory, ".tmp") };
  if (!aliases) {
    if (candidate) environment.PI_SCIENCE_OUTPUT_DIR = outputDirectory;
    else environment.PI_SCIENCE_EVALUATION_PATH = join(outputDirectory, resolve(outputValue).split(sep).at(-1)!);
    if (environment.PI_SCIENCE_SUBJECT_DIR) environment.PI_SCIENCE_SUBJECT_DIR = await realpath(environment.PI_SCIENCE_SUBJECT_DIR);
  }
  if (status.backend === "appcontainer") {
    // A generated script cannot see the host profile through Windows-specific
    // home variables even if its runtime consults those instead of HOME/TMP.
    environment.USERPROFILE = outputDirectory;
    environment.APPDATA = join(outputDirectory, ".appdata");
    environment.LOCALAPPDATA = join(outputDirectory, ".localappdata");
    environment.HOMEDRIVE = win32.parse(outputDirectory).root.slice(0, 2);
    environment.HOMEPATH = outputDirectory.slice(environment.HOMEDRIVE.length);
    await Promise.all([mkdir(environment.APPDATA, { recursive: true }), mkdir(environment.LOCALAPPDATA, { recursive: true })]);
  }
  await mkdir(environment.TMPDIR!, { recursive: true });
  // These are canonical and already checked against runs above. Seatbelt's
  // additional spelling aliases resolve to the same two directories.
  if (!(await lstat(outputDirectory)).isDirectory() || (candidate && !(await lstat(executionCwd)).isDirectory())) throw new Error("sandbox writable path is not a directory");
  let command: string[];
  if (status.backend === "seatbelt") command = ["/usr/bin/sandbox-exec", "-p", macProfile(readable, writable), ...input.command];
  else if (status.backend === "bubblewrap") command = bwrapCommand([commandPath, ...await Promise.all(input.command.slice(1).map(async (arg) => isAbsolute(arg) ? realpath(arg).catch(() => arg) : arg))], readable, writable, executionCwd);
  else {
    const config = windowsResearchSandboxConfig({ commandPath, executionCwd, readable, writable, executableRoots, timeoutSeconds: input.timeoutSeconds });
    if (config.length > 20_000) throw new Error("research AppContainer policy exceeds the Windows command-line limit");
    // Validate the exact policy before the coordinator persists a runnable job.
    const dryRun = await probeAsync(sandyExecutable(), ["--dry-run", "--string", config, "--exec", commandPath], { cwd: executionCwd, env: environment, timeoutMs: 10_000 });
    if (dryRun.status !== 0 || dryRun.error) throw new Error(`research AppContainer policy rejected: ${probeFailure(dryRun)}`);
    // Node resolves the main script through the drive root on Windows. The
    // AppContainer deliberately cannot read that root, so preserve the already
    // validated script path instead of asking Node to canonicalize it again.
    const argumentsAfterExecutable = commandPath === await realpath(process.execPath)
      ? ["--preserve-symlinks-main", ...input.command.slice(1)]
      : input.command.slice(1);
    command = [sandyExecutable(), "--quiet", "--string", config, "--exec", commandPath, ...argumentsAfterExecutable];
  }
  return { command, environment, backend: status.backend };
}

/** Isolate a conversation command while keeping the project writable and its
 * shared, versioned interpreter read-only. The caller owns cleanupDirectory. */
export async function sandboxConversationCommand(input: { command: string[]; conversationScript?: string; workspace: string; environment: NodeJS.ProcessEnv; managedEnvironmentPrefix?: string; trustedReadPaths?: string[]; timeoutSeconds?: number; platform?: NodeJS.Platform }): Promise<{ command: string[]; environment: NodeJS.ProcessEnv; backend: ResearchSandboxBackend; cleanupDirectory: string }> {
  const platform = input.platform ?? process.platform;
  if (platform === "win32") throw new Error(WINDOWS_CONVERSATION_UNAVAILABLE);

  const status = await cachedResearchSandboxStatus(platform);
  if (!status.available) throw new Error(`conversation execution isolation unavailable: ${status.reason}`);
  if (!input.managedEnvironmentPrefix || !input.environment.PI_SCIENCE_ENVIRONMENT_REVISION_ID) throw new Error("conversation execution requires a bound managed environment revision");
  const workspace = await realpath(input.workspace);
  const environmentRoot = await realpath(join(configRoot(), "micromamba", "envs"));
  const prefix = await realpath(input.managedEnvironmentPrefix);
  if (prefix === environmentRoot || !inside(environmentRoot, prefix) || !(await lstat(prefix)).isDirectory()) throw new Error("conversation environment prefix is outside the managed environment root");
  if (inside(workspace, prefix) || inside(prefix, workspace)) throw new Error("conversation workspace overlaps the managed environment prefix");
  const commandPath = await realpath(input.command[0]!);
  const systemRoots = status.backend === "seatbelt" ? macSystemRoots : linuxSystemRoots;
  const approvedCommand = status.backend === "appcontainer"
    ? win32.extname(commandPath).toLowerCase() === ".exe"
    : [...availableSystemRoots(systemRoots), workspace, prefix].some((root) => inside(root, commandPath));
  if (!approvedCommand) throw new Error("conversation executable is outside the approved roots");
  const trustedReadPaths = await Promise.all((input.trustedReadPaths ?? []).map((path) => realpath(path)));
  const cleanupDirectory = await mkdtemp(join(tmpdir(), "pi-science-conversation-"));
  try {
    const canonicalCleanupDirectory = await realpath(cleanupDirectory);
    const scriptPath = input.conversationScript === undefined ? null : join(cleanupDirectory, status.backend === "appcontainer" ? "command.cmd" : "command.sh");
    if (scriptPath) await writeFile(scriptPath, input.conversationScript!, { encoding: "utf8", mode: 0o600 });
    const executionCommand = scriptPath
      ? status.backend === "appcontainer" ? [...input.command, "/d", "/s", "/c", scriptPath] : [...input.command, scriptPath]
      : input.command;
    const aliases = status.backend === "seatbelt";
    const legacyMetadata = legacyMetadataRoot(workspace);
    const nestedLegacyMetadata = inside(workspace, legacyMetadata) ? legacyMetadata : null;
    const cleanupPaths = status.backend === "appcontainer" ? [canonicalCleanupDirectory] : [cleanupDirectory, canonicalCleanupDirectory];
    const readable = [...(status.backend === "appcontainer" ? [] : availableSystemRoots(systemRoots)), workspace, prefix, ...cleanupPaths, ...trustedReadPaths, ...await selectedNodeReadPaths(workspace), ...(aliases ? [input.workspace, input.managedEnvironmentPrefix, input.command[0]!, ...(input.trustedReadPaths ?? [])] : [])];
    const writable = [workspace, ...cleanupPaths, ...(aliases ? [input.workspace] : [])];
    const environment: NodeJS.ProcessEnv = { ...input.environment, HOME: cleanupDirectory, TMPDIR: cleanupDirectory, TMP: cleanupDirectory, TEMP: cleanupDirectory };
    let command: string[] = ["/usr/bin/sandbox-exec", "-p", macProfile(readable, writable, nestedLegacyMetadata ? [nestedLegacyMetadata] : []), ...executionCommand];
    if (status.backend === "bubblewrap") {
      const hidden: Array<{ source: string; target: string }> = [];
      if (nestedLegacyMetadata) {
        const emptyMetadata = join(cleanupDirectory, "hidden-metadata");
        await mkdir(emptyMetadata);
        hidden.push({ source: emptyMetadata, target: nestedLegacyMetadata });
      }
      command = bwrapCommand([commandPath, ...executionCommand.slice(1)], readable, writable, workspace, hidden);
    } else if (status.backend === "appcontainer") {
      const cleanup = await probeAsync(sandyExecutable(), ["--cleanup"], { timeoutMs: 10_000 });
      if (cleanup.status !== 0 || cleanup.error) throw new Error(`conversation AppContainer cleanup failed: ${probeFailure(cleanup)}`);
      environment.USERPROFILE = canonicalCleanupDirectory;
      environment.APPDATA = join(canonicalCleanupDirectory, ".appdata");
      environment.LOCALAPPDATA = join(canonicalCleanupDirectory, ".localappdata");
      environment.HOMEDRIVE = win32.parse(canonicalCleanupDirectory).root.slice(0, 2);
      environment.HOMEPATH = canonicalCleanupDirectory.slice(environment.HOMEDRIVE.length);
      await Promise.all([mkdir(environment.APPDATA, { recursive: true }), mkdir(environment.LOCALAPPDATA, { recursive: true })]);
      const config = windowsResearchSandboxConfig({ commandPath, executionCwd: workspace, readable, writable, executableRoots: [prefix], timeoutSeconds: input.timeoutSeconds });
      if (config.length > 20_000) throw new Error("conversation AppContainer policy exceeds the Windows command-line limit");
      const dryRun = await probeAsync(sandyExecutable(), ["--dry-run", "--string", config, "--exec", commandPath], { cwd: workspace, env: environment, timeoutMs: 10_000 });
      if (dryRun.status !== 0 || dryRun.error) throw new Error(`conversation AppContainer policy rejected: ${probeFailure(dryRun)}`);
      command = [sandyExecutable(), "--quiet", "--string", config, "--exec", commandPath, ...executionCommand.slice(1)];
    }
    return { command, environment, backend: status.backend, cleanupDirectory };
  } catch (error) {
    await rm(cleanupDirectory, { recursive: true, force: true });
    throw error;
  }
}
