/** App-shell visual baselines: projects page, workspace landing and the
 *  collapsible sidebar across the fixed viewport matrix. */

import { expect, screenshot, test, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD, VISUAL_LANDING_CWD } from "./fixtures/data.mjs";

test("projects page renders workspace cards", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Visual Demo", { exact: true })).toBeVisible();
  await expect(page.getByText("Shikimate Project", { exact: true })).toBeVisible();
  await screenshot(page, "projects.png");
});

test("workspace landing shows the hero composer", async ({ page }) => {
  // Dedicated session-free cwd: the mock server returns an empty session
  // list here, so nothing can redirect the workspace route into a session
  // and the page must render the true landing hero.
  await page.goto(workspaceRoute(VISUAL_LANDING_CWD));
  // Real landing hero: welcome copy plus the centered composer.
  await expect(page.getByRole("heading", { name: "Pi-Science" })).toBeVisible();
  await expect(page.getByText("Scientific AI Workbench", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();
  // No auto-navigation: the URL still points at the workspace root and the
  // session list for this cwd is empty.
  await expect(page).toHaveURL(new RegExp(`/workspace/${encodeURIComponent(VISUAL_LANDING_CWD).replace(/\//g, "\\/")}$`));
  await screenshot(page, "workspace-landing.png");
});

test("collapsed sidebar leaves a stable icon rail", async ({ page }, testInfo) => {
  // On the mobile project the layout auto-collapses the sidebar at mount, so
  // the "Close sidebar" affordance does not exist there.
  test.skip(testInfo.project.name === "mobile", "mobile starts with the rail already collapsed");
  await page.goto(workspaceRoute(VISUAL_CWD));
  await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();
  await page.getByRole("button", { name: "Close sidebar" }).click();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await screenshot(page, "sidebar-collapsed.png");
});
