import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkoutRoot(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../../..");
}

export function desktopRuntimeRoot(packaged: boolean, resourcesPath: string, moduleUrl: string): string {
  return packaged ? join(resourcesPath, "desktop-runtime") : checkoutRoot(moduleUrl);
}

export function desktopRunnerPath(packaged: boolean, root: string): string {
  return packaged ? join(root, "server-runner.cjs") : join(root, "apps", "desktop", "src", "server-runner.cjs");
}

export function serverLauncherPath(packaged: boolean, root: string): string {
  return packaged ? join(root, "server", "dist", "launcher", "launcher.js") : join(root, "apps", "server", "dist", "launcher", "launcher.js");
}

export function frontendDistPath(packaged: boolean, root: string): string {
  return packaged ? join(root, "frontend") : join(root, "frontend", "dist");
}

export function piCliPath(packaged: boolean, root: string): string {
  const runtimeRoot = join(root, "runtime", "pi");
  if (packaged) return join(root, readFileSync(join(runtimeRoot, ".cli-path-relative"), "utf8").trim());
  return readFileSync(join(runtimeRoot, ".cli-path"), "utf8").trim();
}
