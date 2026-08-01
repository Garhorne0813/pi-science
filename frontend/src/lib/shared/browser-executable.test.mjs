import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { browserExecutableCandidates, resolveBrowserExecutable } from "../../../scripts/browser-executable.mjs";

describe("UAT browser executable discovery", () => {
  it("discovers Chrome and Edge under standard Windows installation roots", () => {
    const candidates = browserExecutableCandidates("win32", { PROGRAMFILES: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" });
    expect(candidates).toContain(path.join("C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"));
    expect(candidates).toContain(path.join("C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"));
  });

  it("honours and validates CHROME_PATH", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-browser-test-"));
    const executable = path.join(root, "browser.exe");
    try {
      await writeFile(executable, "", "utf8");
      await expect(resolveBrowserExecutable("win32", { CHROME_PATH: executable })).resolves.toBe(executable);
      await expect(resolveBrowserExecutable("win32", { CHROME_PATH: path.join(root, "missing.exe") })).rejects.toThrow(/CHROME_PATH does not exist/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
