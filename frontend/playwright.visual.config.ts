/** Visual regression + accessibility test configuration.
 *
 *  Runs against the production build served by the fixture mock server
 *  (tests/visual/fixtures/mock-server.mjs) so REST and SSE data are fixed.
 *  Uses the system Chrome/Chromium/Edge executable like the UAT scripts —
 *  no Playwright browser download is required (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
 *  is expected during install).
 */

import { accessSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
];

function resolveExecutable(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return CHROME_CANDIDATES.find((candidate) => {
    try {
      accessSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

const executablePath = resolveExecutable();
if (!executablePath) {
  throw new Error(
    "No Chrome/Chromium/Edge executable found for the visual suite. "
    + "Install one of the browsers in tests/visual/README or set CHROME_PATH.",
  );
}

export default defineConfig({
  testDir: "./tests/visual",
  outputDir: "./tests/visual/.artifacts",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.005,
      animations: "disabled",
      caret: "hide",
    },
  },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  webServer: {
    command: "node tests/visual/fixtures/mock-server.mjs",
    url: "http://127.0.0.1:4173/api/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
    launchOptions: { executablePath },
  },
  projects: [
    { name: "desktop-light", use: { viewport: { width: 1440, height: 1000 }, colorScheme: "light" } },
    { name: "desktop-dark", use: { viewport: { width: 1440, height: 1000 }, colorScheme: "dark" } },
    { name: "mobile", use: { viewport: { width: 375, height: 812 }, colorScheme: "light" } },
    { name: "tablet", use: { viewport: { width: 768, height: 1024 }, colorScheme: "light" } },
    { name: "wide", use: { viewport: { width: 1920, height: 1080 }, colorScheme: "light" } },
  ],
});
