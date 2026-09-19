import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { configRoot, metadataRoot } from "../../storage/persistence.js";

export type ResearchSandboxBackend = "seatbelt" | "bubblewrap" | "appcontainer";
export type ResearchSandboxStatus = { available: true; backend: ResearchSandboxBackend } | { available: false; reason: string };

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

function macProfile(readable: string[], writable: string[]): string {
  const ancestorRules = [...new Set([...readable, ...writable].flatMap(parents))].map((path) => `(literal ${quote(path)})`);
  const readRules = [...new Set(readable)].map((path) => `(subpath ${quote(path)})`);
  const writeRules = [...new Set(writable)].map((path) => `(subpath ${quote(path)})`);
  return [
    "(version 1)", "(deny default)",
    "(allow process-exec)", "(allow process-fork)",
    "(allow process-info* (target same-sandbox))", "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.libinfo\") (global-name \"com.apple.system.opendirectoryd.membership\") (global-name \"com.apple.logd\"))",
    `(allow file-read* ${[...ancestorRules, ...readRules].join(" ")})`,
    `(allow file-write* ${writeRules.join(" ")})`,
  ].join("\n");
}

function availableSystemRoots(roots: string[]): string[] { return roots.filter(existsSync); }

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

/** Sandy uses a per-run AppContainer SID and a Job Object; no restricted-token fallback. */
export function windowsResearchSandboxConfig(input: { commandPath: string; executionCwd: string; readable: string[]; writable: string[]; executableRoots?: string[]; timeoutSeconds?: number }): string {
  const runtimeRoot = windowsRuntimeReadRoot(input.commandPath);
  return [
    "[sandbox]",
    "token = 'appcontainer'",
    `workdir = ${tomlString(input.executionCwd)}`,
    "[allow.deep]",
    `execute = ${tomlArray([runtimeRoot, ...(input.executableRoots ?? [])].filter((path): path is string => Boolean(path)))}`,
    `read = ${tomlArray(input.readable)}`,
    `all = ${tomlArray(input.writable)}`,
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

function bwrapCommand(command: string[], readable: string[], writable: string[], cwd = "/"): string[] {
  const args = ["--unshare-user", "--disable-userns", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net", "--new-session", "--die-with-parent", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
  for (const path of [...new Set(readable)]) args.push("--ro-bind", path, path);
  for (const path of [...new Set(writable)]) args.push("--bind", path, path);
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

export async function sandboxResearchCommand(input: { command: string[]; workspace: string; executionCwd: string; surface: string; environment: NodeJS.ProcessEnv; managedEnvironmentPrefix?: string; timeoutSeconds?: number; platform?: NodeJS.Platform }): Promise<{ command: string[]; environment: NodeJS.ProcessEnv; backend: ResearchSandboxBackend }> {
  const status = researchSandboxStatus(input.platform);
  if (!status.available) throw new Error(`research execution isolation unavailable: ${status.reason}`);
  const workspace = await realpath(input.workspace);
  if (status.backend === "appcontainer") {
    const launcher = await realpath(sandyExecutable());
    if (inside(workspace, launcher)) throw new Error("research AppContainer launcher must be outside the workspace");
    // taskkill may terminate the broker before it can restore transient ACLs.
    // Sandy records those grants and repairs only stale instances on cleanup.
    const cleanup = spawnSync(sandyExecutable(), ["--cleanup"], { timeout: 10_000, encoding: "utf8", windowsHide: true });
    if (cleanup.status !== 0) throw new Error(`research AppContainer cleanup failed: ${cleanup.error?.message ?? cleanup.stderr?.trim() ?? cleanup.status}`);
  }
  const runs = await realpath(join(metadataRoot(workspace), "runs"));
  if (!inside(workspace, runs)) throw new Error("research run root escapes the workspace");
  const requestedWorkspace = resolve(input.workspace);
  const requestedExecutionCwd = resolve(input.executionCwd);
  if (requestedExecutionCwd !== requestedWorkspace && !requestedExecutionCwd.startsWith(`${requestedWorkspace}${sep}`)) throw new Error("research execution directory escapes the workspace");
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
  const writable = candidate ? [executionCwd, outputDirectory, ...(aliases ? [input.executionCwd, originalOutput] : [])] : [outputDirectory, ...(aliases ? [originalOutput] : [])];
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
    const dryRun = spawnSync(sandyExecutable(), ["--dry-run", "--string", config, "--exec", commandPath], { cwd: executionCwd, env: environment, timeout: 10_000, encoding: "utf8", windowsHide: true });
    if (dryRun.status !== 0) throw new Error(`research AppContainer policy rejected: ${dryRun.error?.message ?? dryRun.stderr?.trim() ?? dryRun.status}`);
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
