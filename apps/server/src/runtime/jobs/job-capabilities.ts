import { spawnSync } from "node:child_process";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { defaultPythonExecutable } from "../workspace/workspace-environment.js";
import type { JobRequirement } from "./job-types.js";

export type JobGpuProbeSource = "nvidia-smi" | "rocm-smi" | "rocminfo" | "system_profiler" | "powershell" | "visibility-env" | "none";

export interface JobGpuCapability {
  available: boolean;
  source: JobGpuProbeSource;
  vendor?: string;
  model?: string;
  memory_mb?: number;
  driver?: string;
}

export interface JobEnvironmentCapability {
  revision_id: string | null;
  ready: boolean | null;
  prefix: string | null;
  packages: string[];
}

export interface JobCapabilityReport {
  status: "ready" | "blocked";
  checks: {
    cpu: number;
    memory_mb: number;
    gpu: boolean;
    gpu_details: JobGpuCapability;
    runtime: { node: string; python: string | null; r: string | null };
    packages: Record<string, boolean>;
    environment: JobEnvironmentCapability;
  };
  reasons: string[];
}

export interface JobCapabilityOptions {
  /** Environment used for runtime/package probes; defaults to the server env. */
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  environment_revision_id?: string | null;
  environment_ready?: boolean | null;
  environment_prefix?: string | null;
  environment_packages?: readonly string[];
  platform?: NodeJS.Platform;
  cpu?: number;
  memory_mb?: number;
  /** Test/integration override for the host GPU probe. */
  gpu?: JobGpuCapability;
}

interface CommandOutput {
  ok: boolean;
  stdout: string;
}

let gpuProbeCache: { key: string; value: JobGpuCapability } | null = null;

/** Clear the host GPU probe cache; useful when a long-lived process changes visibility. */
export function resetJobCapabilityProbeCache(): void {
  gpuProbeCache = null;
}

export function detectJobCapabilities(requirement: JobRequirement, options: JobCapabilityOptions = {}): JobCapabilityReport {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const cpu = options.cpu ?? availableParallelism();
  const memory_mb = options.memory_mb ?? Math.floor(totalmem() / (1024 * 1024));
  const environmentRevisionId = options.environment_revision_id
    ?? environment.PI_SCIENCE_ENVIRONMENT_REVISION_ID
    ?? null;
  const environmentPrefix = options.environment_prefix
    ?? environment.PI_SCIENCE_ENVIRONMENT_PREFIX
    ?? null;
  const environmentReady = options.environment_ready
    ?? (environmentRevisionId ? true : null);
  const environmentPackages = options.environment_packages;
  const pythonExecutable = detectExecutable(
    environmentPrefix ? environmentRuntimeExecutable(environmentPrefix, "python", platform) : defaultPythonExecutable(environment, platform),
    environment,
  );
  const rExecutable = detectExecutable(
    environmentPrefix ? environmentRuntimeExecutable(environmentPrefix, "r", platform) : "Rscript",
    environment,
  );
  const runtime = { node: process.execPath, python: pythonExecutable, r: rExecutable };
  const gpu_details = options.gpu ?? detectGpu(environment, platform);
  const checks = {
    cpu,
    memory_mb,
    gpu: gpu_details.available,
    gpu_details,
    runtime,
    packages: detectPackages(requirement, runtime, environmentPackages, environment, options.cwd),
    environment: {
      revision_id: environmentRevisionId,
      ready: environmentReady,
      prefix: environmentPrefix,
      packages: environmentPackages ? [...environmentPackages] : [],
    },
  };
  const reasons: string[] = [];
  const requestedCpu = Number(requirement.cpu ?? 1);
  if (Number.isFinite(requestedCpu) && requestedCpu > cpu) reasons.push(`requires ${requirement.cpu} CPUs, host has ${cpu}`);
  const requestedMemory = Number(requirement.memory_mb ?? 0);
  if (Number.isFinite(requestedMemory) && requestedMemory > memory_mb) reasons.push(`requires ${requirement.memory_mb} MB, host has ${memory_mb} MB`);
  if (requirement.gpu && !checks.gpu) reasons.push("GPU requested but no GPU was detected");
  const runtimeName = typeof requirement.runtime === "string" ? requirement.runtime.toLowerCase() : "";
  if (runtimeName && runtimeName !== "any" && !(runtimeName in runtime && runtime[runtimeName as keyof typeof runtime])) reasons.push(`runtime not found: ${requirement.runtime}`);

  const requestedRevision = requestedEnvironmentRevision(requirement);
  if (requestedRevision && environmentRevisionId !== requestedRevision) {
    reasons.push(`requires environment revision ${requestedRevision}, workspace has ${environmentRevisionId ?? "none"}`);
  }
  if (requestedRevision && environmentReady === false) reasons.push(`environment revision ${environmentRevisionId ?? requestedRevision} is not ready`);
  const requestedPackages = Array.isArray(requirement.packages) && requirement.packages.some((item) => typeof item === "string" && item.trim().length > 0);
  if (environmentReady === false && (requestedPackages || runtimeName === "python" || runtimeName === "r")) reasons.push("workspace environment is not ready");
  for (const [packageSpec, available] of Object.entries(checks.packages)) {
    if (!available) reasons.push(`package not available: ${packageSpec}`);
  }

  return { status: reasons.length ? "blocked" : "ready", checks, reasons };
}

function requestedEnvironmentRevision(requirement: JobRequirement): string | null {
  const value = requirement.environment_revision_id ?? requirement.environment_revision;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function environmentRuntimeExecutable(prefix: string, runtime: "python" | "r", platform: NodeJS.Platform): string {
  const bin = platform === "win32" ? join(prefix, "Scripts") : join(prefix, "bin");
  const executable = runtime === "r" ? "Rscript" : "python";
  return join(bin, platform === "win32" ? `${executable}.exe` : executable);
}

function detectPackages(
  requirement: JobRequirement,
  runtime: { node: string; python: string | null; r: string | null },
  environmentPackages: readonly string[] | undefined,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
): Record<string, boolean> {
  const requested = Array.isArray(requirement.packages) ? requirement.packages.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  const result: Record<string, boolean> = {};
  for (const packageSpec of requested) {
    if (environmentPackages !== undefined) {
      result[packageSpec] = environmentPackages.some((installed) => packageNamesMatch(packageSpec, installed));
      continue;
    }
    const runtimeName = typeof requirement.runtime === "string" ? requirement.runtime.toLowerCase() : "python";
    const packageName = normalizedPackageName(packageSpec);
    result[packageSpec] = runtimeName === "r"
      ? probeRPackage(runtime.r, packageName, environment, cwd)
      : runtimeName === "node" || runtimeName === "javascript"
        ? probeNodePackage(runtime.node, packageName, environment, cwd)
        : probePythonPackage(runtime.python, packageName, environment, cwd);
  }
  return result;
}

function normalizedPackageName(spec: string): string {
  const channelFree = spec.trim().split("::").pop() ?? spec.trim();
  return channelFree.split(/[<>=!~\[\s]/, 1)[0]!.trim().toLowerCase().replaceAll("_", "-");
}

function packageNamesMatch(requested: string, installed: string): boolean {
  return normalizedPackageName(requested) === normalizedPackageName(installed);
}

function probePythonPackage(executable: string | null, packageName: string, environment: NodeJS.ProcessEnv, cwd: string | undefined): boolean {
  if (!executable) return false;
  return runCommand(executable, ["-c", "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec(sys.argv[1]) else 1)", packageName.replaceAll("-", "_")], environment, cwd).ok;
}

function probeRPackage(executable: string | null, packageName: string, environment: NodeJS.ProcessEnv, cwd: string | undefined): boolean {
  if (!executable) return false;
  return runCommand(executable, ["-e", "args <- commandArgs(trailingOnly=TRUE); quit(status=ifelse(requireNamespace(args[[1]], quietly=TRUE), 0, 1))", packageName], environment, cwd).ok;
}

function probeNodePackage(executable: string, packageName: string, environment: NodeJS.ProcessEnv, cwd: string | undefined): boolean {
  return runCommand(executable, ["-e", "try { require.resolve(process.argv[1]); process.exit(0) } catch { process.exit(1) }", packageName], environment, cwd).ok;
}

function detectExecutable(command: string, environment: NodeJS.ProcessEnv): string | null {
  return runCommand(command, ["--version"], environment).ok ? command : null;
}

function runCommand(command: string, args: string[], environment: NodeJS.ProcessEnv, cwd?: string, timeout = 1_500): CommandOutput {
  try {
    const probe = spawnSync(command, args, { cwd, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout, windowsHide: true });
    return { ok: probe.status === 0, stdout: typeof probe.stdout === "string" ? probe.stdout : "" };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function detectGpu(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): JobGpuCapability {
  const visibility = visibleGpu(environment);
  const cacheKey = `${platform}:${visibility ? "visible" : "hidden"}`;
  if (gpuProbeCache?.key === cacheKey) return gpuProbeCache.value;

  const result = platform === "darwin"
    ? probeAppleGpu(environment)
    : probeNvidiaGpu(environment) ?? probeAmdGpu(environment) ?? (platform === "win32" ? probeWindowsGpu(environment) : null)
      ?? (visibility ? { available: true, source: "visibility-env" as const } : { available: false, source: "none" as const });
  gpuProbeCache = { key: cacheKey, value: result };
  return result;
}

function visibleGpu(environment: NodeJS.ProcessEnv): boolean {
  return ["CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES"].some((key) => {
    const value = environment[key]?.trim();
    return Boolean(value && !["-1", "none", "nodevfiles"].includes(value.toLowerCase()));
  });
}

function probeNvidiaGpu(environment: NodeJS.ProcessEnv): JobGpuCapability | null {
  const output = runCommand("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"], environment).stdout.trim();
  if (!output) return null;
  const [model, memory, driver] = output.split(/\r?\n/, 1)[0]!.split(",").map((item) => item.trim());
  const memory_mb = Number(memory);
  return { available: true, source: "nvidia-smi", vendor: "NVIDIA", ...(model ? { model } : {}), ...(Number.isFinite(memory_mb) ? { memory_mb } : {}), ...(driver ? { driver } : {}) };
}

function probeAmdGpu(environment: NodeJS.ProcessEnv): JobGpuCapability | null {
  const rocmSmi = runCommand("rocm-smi", ["--showproductname", "--csv"], environment).stdout.trim();
  if (rocmSmi && !/error|not found|unsupported/i.test(rocmSmi)) {
    const model = rocmSmi.split(/\r?\n/).find((line) => line.trim() && !/^GPU/i.test(line))?.split(",").pop()?.trim();
    return { available: true, source: "rocm-smi", vendor: "AMD", ...(model ? { model } : {}) };
  }
  const info = runCommand("rocminfo", [], environment).stdout;
  const model = info.split(/\r?\n/).map((line) => line.match(/^\s*Name:\s*(.+)$/i)?.[1]?.trim()).find((name) => name && !/cpu|ryzen|host/i.test(name));
  return model ? { available: true, source: "rocminfo", vendor: "AMD", model } : null;
}

function probeAppleGpu(environment: NodeJS.ProcessEnv): JobGpuCapability {
  const output = runCommand("system_profiler", ["SPDisplaysDataType", "-json"], environment, undefined, 3_000).stdout;
  if (!output) return { available: false, source: "none" };
  try {
    const models: string[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== "object") return;
      for (const [key, nested] of Object.entries(value)) {
        if (["sppci_model", "spdisplays_device-name", "_name"].includes(key) && typeof nested === "string" && nested.trim()) models.push(nested.trim());
        visit(nested);
      }
    };
    visit(JSON.parse(output) as unknown);
    const model = models.find((item) => !/display|retina/i.test(item)) ?? models[0];
    return { available: Boolean(model), source: model ? "system_profiler" : "none", ...(model?.toLowerCase().includes("apple") ? { vendor: "Apple" } : {}), ...(model ? { model } : {}) };
  } catch {
    return { available: false, source: "none" };
  }
}

function probeWindowsGpu(environment: NodeJS.ProcessEnv): JobGpuCapability | null {
  const output = runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"], environment).stdout.trim();
  const model = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return model ? { available: true, source: "powershell", model } : null;
}
