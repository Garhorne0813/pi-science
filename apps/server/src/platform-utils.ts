import { access } from "node:fs/promises";
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

export async function findExecutable(command: string, environment: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<string | null> {
  const pathValue = environment.PATH || environment.Path || environment.path || "";
  const directories = pathValue.split(platform === "win32" ? ";" : delimiter).map((value) => value.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const extensions = platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const names = platform === "win32" && !extname(command) ? extensions.map((extension) => `${command}${extension}`) : [command];
  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? (platform === "win32" && !extname(command) ? extensions.map((extension) => `${command}${extension}`) : [command])
    : directories.flatMap((directory) => names.map((name) => join(directory, name)));
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* try next */ }
  }
  return null;
}

export async function findBashExecutable(environment: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<string | null> {
  if (environment.PI_SCIENCE_BASH_PATH) return findExecutable(environment.PI_SCIENCE_BASH_PATH, environment, platform);
  const fromPath = await findExecutable("bash", environment, platform);
  if (fromPath || platform !== "win32") return fromPath;
  const roots = [environment.PROGRAMFILES, environment["PROGRAMFILES(X86)"], environment.LOCALAPPDATA].filter((value): value is string => Boolean(value));
  for (const root of roots) {
    for (const candidate of [join(root, "Git", "bin", "bash.exe"), join(root, "Git", "usr", "bin", "bash.exe")]) {
      try { await access(candidate); return candidate; } catch { /* try next */ }
    }
  }
  return null;
}
