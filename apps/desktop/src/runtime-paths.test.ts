import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { desktopRunnerPath, desktopRuntimeRoot, frontendDistPath, serverLauncherPath } from "./runtime-paths.js";

describe("desktop runtime paths", () => {
  it("uses extra resources for a packaged application", () => {
    const root = desktopRuntimeRoot(true, "/Applications/Pi-Science.app/Contents/Resources", import.meta.url);
    expect(root).toBe("/Applications/Pi-Science.app/Contents/Resources/desktop-runtime");
    expect(desktopRunnerPath(true, root)).toBe(join(root, "server-runner.cjs"));
    expect(serverLauncherPath(true, root)).toBe(join(root, "server", "dist", "launcher", "launcher.js"));
    expect(frontendDistPath(true, root)).toBe(join(root, "frontend"));
  });

  it("uses workspace build outputs in development", () => {
    const root = "/workspace/pi-science";
    expect(desktopRunnerPath(false, root)).toBe("/workspace/pi-science/apps/desktop/src/server-runner.cjs");
    expect(serverLauncherPath(false, root)).toBe("/workspace/pi-science/apps/server/dist/launcher/launcher.js");
    expect(frontendDistPath(false, root)).toBe("/workspace/pi-science/frontend/dist");
  });
});
