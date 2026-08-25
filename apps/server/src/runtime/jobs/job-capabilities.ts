import { spawnSync } from "node:child_process";
import { availableParallelism, totalmem } from "node:os";
import { defaultPythonExecutable } from "../workspace/workspace-environment.js";
import type { JobRequirement } from "./job-types.js";

export interface JobCapabilityReport {
  status: "ready" | "blocked";
  checks: {
    cpu: number;
    memory_mb: number;
    gpu: boolean;
    runtime: { node: string; python: string | null; r: string | null };
    packages: Record<string, boolean>;
  };
  reasons: string[];
}

export function detectJobCapabilities(requirement: JobRequirement): JobCapabilityReport {
  const cpu = availableParallelism();
  const memory_mb = Math.floor(totalmem() / (1024 * 1024));
  const python = defaultPythonExecutable();
  const runtime = { node: process.execPath, python: detectExecutable(python), r: detectExecutable("Rscript") };
  const checks = {
    cpu,
    memory_mb,
    gpu: Boolean(process.env.CUDA_VISIBLE_DEVICES || process.env.NVIDIA_VISIBLE_DEVICES || process.env.ROCR_VISIBLE_DEVICES || process.env.HIP_VISIBLE_DEVICES),
    runtime,
    packages: {},
  };
  const reasons: string[] = [];
  const requestedCpu = Number(requirement.cpu ?? 1);
  if (Number.isFinite(requestedCpu) && requestedCpu > cpu) reasons.push(`requires ${requirement.cpu} CPUs, host has ${cpu}`);
  const requestedMemory = Number(requirement.memory_mb ?? 0);
  if (Number.isFinite(requestedMemory) && requestedMemory > memory_mb) reasons.push(`requires ${requirement.memory_mb} MB, host has ${memory_mb} MB`);
  if (requirement.gpu && !checks.gpu) reasons.push("GPU requested but no visible GPU was detected");
  const runtimeName = typeof requirement.runtime === "string" ? requirement.runtime.toLowerCase() : "";
  if (runtimeName && runtimeName !== "any" && !(runtimeName in runtime && runtime[runtimeName as keyof typeof runtime])) reasons.push(`runtime not found: ${requirement.runtime}`);
  return { status: reasons.length ? "blocked" : "ready", checks, reasons };
}

function detectExecutable(command: string): string | null {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 1_000, windowsHide: true });
  return probe.status === 0 ? command : null;
}
