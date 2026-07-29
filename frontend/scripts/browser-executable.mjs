import { access } from "node:fs/promises";
import path from "node:path";

export function browserExecutableCandidates(platform = process.platform, environment = process.env) {
  if (environment.CHROME_PATH) return [environment.CHROME_PATH];
  if (platform === "darwin") return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  if (platform === "win32") {
    const roots = [environment.PROGRAMFILES, environment["PROGRAMFILES(X86)"], environment.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap((root) => [
      path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(root, "Chromium", "Application", "chrome.exe"),
    ]);
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
}

export async function resolveBrowserExecutable(platform = process.platform, environment = process.env) {
  const candidates = browserExecutableCandidates(platform, environment);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* try next */ }
  }
  const override = environment.CHROME_PATH ? `CHROME_PATH does not exist: ${environment.CHROME_PATH}` : "No supported Chrome, Chromium, or Edge executable was found";
  throw new Error(`${override}. Set CHROME_PATH to the browser executable.`);
}
