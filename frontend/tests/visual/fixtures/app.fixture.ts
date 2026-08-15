/** Shared Playwright fixture for the visual regression suite.
 *
 *  - Freezes wall-clock time for the page so relative timestamps in the UI
 *    are deterministic.
 *  - Applies the persisted theme from the project config (colorScheme alone
 *    does not switch the app: Pi-Science's theme is user-controlled and
 *    defaults to light).
 *  - Turns any uncaught page error into a test failure so screenshots never
 *    paper over a crash.
 */

import { test as base, expect } from "@playwright/test";
import { FIXED_NOW } from "./data.mjs";

export const test = base.extend({
  page: async ({ page }, commit, testInfo) => {
    await page.clock.setFixedTime(new Date(FIXED_NOW));
    const colorScheme = testInfo.project.use.colorScheme;
    if (colorScheme === "dark") {
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("pi-science.theme", JSON.stringify("dark"));
        } catch {
          // storage unavailable (privacy mode) — fall back to light
        }
      });
    }
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await commit(page);
    expect(pageErrors, "uncaught page errors during the visual test").toEqual([]);
  },
});

export { expect } from "@playwright/test";

/** Wait for webfonts before capturing: @fontsource ships font-display: swap,
 *  so a screenshot taken mid-load would capture fallback metrics and drift
 *  between runs. */
export async function screenshot(page: import("@playwright/test").Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot(name);
}

/** Workspace route helper — the cwd is always URL-encoded in the path. */
export function workspaceRoute(cwd: string, suffix = ""): string {
  return `/workspace/${encodeURIComponent(cwd)}${suffix}`;
}
