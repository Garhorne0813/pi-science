/**
 * Skill dependency readiness probing.
 *
 * Probe results are advisory: a blocked required dependency means the skill
 * will likely fail at runtime, but pi-science never auto-installs anything.
 * The probe is split into pure aggregation (`probeRequirements`) and
 * injectable environment probes so tests can run without spawning python.
 */

import { spawn } from "node:child_process";
import type { SkillRequirement } from "@pi-science/contracts";
import { findExecutable } from "../support/platform-utils.js";

export type RequirementStatus = "ready" | "missing" | "missing-optional" | "not-probed";

export interface RequirementProbe {
  name: string;
  kind: SkillRequirement["kind"];
  optional: boolean;
  version: string | null;
  status: RequirementStatus;
  reason?: string;
  hint?: string;
}

export interface ReadinessResult {
  skill_id: string;
  ready: boolean;
  requirements: RequirementProbe[];
}

export interface RequirementProbeEnv {
  /** Command existence check; defaults to a real PATH lookup. */
  findExecutableFn?: (command: string) => Promise<string | null>;
  /** Python interpreter discovery; defaults to PI_SCIENCE_PYTHON, then python3/python on PATH. */
  findPythonFn?: () => Promise<string | null>;
  /** Python interpreter sanity + version probe. */
  checkPythonFn?: (pythonPath: string) => Promise<{ ok: boolean; version?: string }>;
  /** Import check for a package inside the discovered python. */
  checkPackageFn?: (moduleName: string, pythonPath: string) => Promise<boolean>;
}

/** Common install hints kept in one place; anything else falls back to a generic hint. */
const INSTALL_HINTS: Record<string, string> = {
  python: "Install Python 3.11+ (brew install python / apt install python3)",
  numpy: "pip install numpy",
  scipy: "pip install scipy",
  pandas: "pip install pandas",
  matplotlib: "pip install matplotlib",
  scanpy: "pip install scanpy",
  anndata: "pip install anndata",
  pypdf: "pip install pypdf",
  openpyxl: "pip install openpyxl",
  rdkit: "pip install rdkit",
  pandoc: "brew install pandoc / apt install pandoc",
  tectonic: "brew install tectonic / apt install tectonic",
};

/** pip package names use dashes, import module names use underscores. */
function moduleNameOf(packageName: string): string {
  return packageName.replace(/-/g, "_");
}

function hintFor(requirement: SkillRequirement): string | undefined {
  if (requirement.kind === "package") {
    return INSTALL_HINTS[requirement.name] ?? `pip install ${requirement.name}`;
  }
  if (requirement.kind === "command") {
    return INSTALL_HINTS[requirement.name] ?? `Install the "${requirement.name}" command (see its official documentation)`;
  }
  if (requirement.kind === "python") {
    return INSTALL_HINTS.python;
  }
  return undefined;
}

function runPython(
  pythonPath: string,
  args: string[],
  timeoutMs = 15000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(pythonPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: stderr || String(error) });
    });
  });
}

export async function defaultCheckPython(pythonPath: string): Promise<{ ok: boolean; version?: string }> {
  const result = await runPython(pythonPath, ["-c", "import sys; print(sys.version.split()[0])"]);
  if (result.code !== 0 || !result.stdout.trim()) return { ok: false };
  return { ok: true, version: result.stdout.trim() };
}

export async function defaultCheckPackage(moduleName: string, pythonPath: string): Promise<boolean> {
  const script = `import importlib.util,sys;sys.exit(0 if importlib.util.find_spec(${JSON.stringify(moduleName)}) else 1)`;
  const result = await runPython(pythonPath, ["-c", script]);
  return result.code === 0;
}

export async function defaultFindPython(): Promise<string | null> {
  const explicit = process.env.PI_SCIENCE_PYTHON;
  if (explicit) {
    const found = await findExecutable(explicit);
    return found ?? explicit;
  }
  for (const candidate of ["python3", "python"]) {
    const found = await findExecutable(candidate);
    if (found) return found;
  }
  return null;
}

export async function probeRequirements(
  skillId: string,
  requirements: SkillRequirement[],
  env: RequirementProbeEnv = {},
): Promise<ReadinessResult> {
  const findExecutableFn = env.findExecutableFn ?? findExecutable;
  const findPythonFn = env.findPythonFn ?? defaultFindPython;
  const checkPythonFn = env.checkPythonFn ?? defaultCheckPython;
  const checkPackageFn = env.checkPackageFn ?? defaultCheckPackage;

  // The interpreter is discovered lazily and reused across python/package
  // requirements so one probe run issues at most one interpreter lookup.
  let pythonPath: string | null = null;
  let pythonProbed = false;
  const python = async (): Promise<string | null> => {
    if (!pythonProbed) {
      pythonProbed = true;
      pythonPath = await findPythonFn();
    }
    return pythonPath;
  };

  const probes: RequirementProbe[] = [];
  for (const requirement of requirements) {
    const optional = requirement.optional === true;
    const base = {
      name: requirement.name,
      kind: requirement.kind,
      optional,
      version: requirement.version ?? null,
    };
    switch (requirement.kind) {
      case "command": {
        const found = await findExecutableFn(requirement.name);
        probes.push(
          found
            ? { ...base, status: "ready" }
            : {
                ...base,
                status: optional ? "missing-optional" : "missing",
                reason: `Command "${requirement.name}" not found on PATH`,
                hint: hintFor(requirement),
              },
        );
        break;
      }
      case "python": {
        const interpreter = await python();
        if (!interpreter) {
          probes.push({
            ...base,
            status: optional ? "missing-optional" : "missing",
            reason: "No Python interpreter found (PI_SCIENCE_PYTHON, python3, python)",
            hint: hintFor(requirement),
          });
          break;
        }
        const check = await checkPythonFn(interpreter);
        probes.push(
          check.ok
            ? { ...base, status: "ready", version: check.version ?? requirement.version ?? null }
            : {
                ...base,
                status: optional ? "missing-optional" : "missing",
                reason: `Python interpreter "${interpreter}" failed a sanity check`,
                hint: hintFor(requirement),
              },
        );
        break;
      }
      case "package": {
        const interpreter = await python();
        if (!interpreter) {
          probes.push({
            ...base,
            status: optional ? "missing-optional" : "missing",
            reason: "No Python interpreter found (PI_SCIENCE_PYTHON, python3, python)",
            hint: hintFor(requirement),
          });
          break;
        }
        const found = await checkPackageFn(moduleNameOf(requirement.name), interpreter);
        probes.push(
          found
            ? { ...base, status: "ready" }
            : {
                ...base,
                status: optional ? "missing-optional" : "missing",
                reason: `Python package "${requirement.name}" is not installed in ${interpreter}`,
                hint: hintFor(requirement),
              },
        );
        break;
      }
      case "service":
      default:
        // Network services are never probed here (egress/health tooling
        // covers them); treat as satisfied so they do not block readiness.
        probes.push({ ...base, status: "not-probed" });
        break;
    }
  }

  const blocked = probes.some((probe) => probe.status === "missing");
  return { skill_id: skillId, ready: !blocked, requirements: probes };
}
