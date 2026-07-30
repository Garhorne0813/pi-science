import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function userHome(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.HOME || environment.USERPROFILE || homedir();
}

export function pathIsInside(root: string, target: string, allowRoot = false): boolean {
  const rel = relative(resolve(root), resolve(target));
  if (!rel) return allowRoot;
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function environmentValue(environment: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (environment[key] !== undefined || platform !== "win32") return environment[key];
  return Object.entries(environment).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase())?.[1];
}

export async function findExecutable(command: string, environment: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<string | null> {
  const pathValue = environmentValue(environment, "PATH", platform) ?? "";
  const directories = pathValue.split(platform === "win32" ? ";" : delimiter).map((value) => value.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const extensions = platform === "win32"
    ? (environmentValue(environment, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const names = platform === "win32" && !extname(command) ? extensions.map((extension) => `${command}${extension}`) : [command];
  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? (platform === "win32" && !extname(command) ? extensions.map((extension) => `${command}${extension}`) : [command])
    : directories.flatMap((directory) => names.map((name) => join(directory, name)));
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch { /* try next */ }
  }
  return null;
}

export async function findBashExecutable(environment: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<string | null> {
  if (environment.PI_SCIENCE_BASH_PATH) return findExecutable(environment.PI_SCIENCE_BASH_PATH, environment, platform);
  const fromPath = await findExecutable("bash", environment, platform);
  if (fromPath || platform !== "win32") return fromPath;
  const roots = [environment.PROGRAMFILES, environment["PROGRAMFILES(X86)"]].filter((value): value is string => Boolean(value));
  const gitRoots = [
    ...roots.map((root) => join(root, "Git")),
    ...(environment.LOCALAPPDATA ? [join(environment.LOCALAPPDATA, "Programs", "Git"), join(environment.LOCALAPPDATA, "Git")] : []),
  ];
  for (const root of gitRoots) {
    for (const candidate of [join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe")]) {
      try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* try next */ }
    }
  }
  return null;
}
