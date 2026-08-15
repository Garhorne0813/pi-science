/** App-shell visual baselines: projects page, workspace landing and the
 *  collapsible sidebar across the fixed viewport matrix. */

import { expect, screenshot, test, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD } from "./fixtures/data.mjs";

test("projects page renders workspace cards", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Visual Demo", { exact: true })).toBeVisible();
  await expect(page.getByText("Shikimate Project", { exact: true })).toBeVisible();
  await screenshot(page, "projects.png");
});

test("workspace landing shows the hero composer", async ({ page }) => {
  await page.goto(workspaceRoute(VISUAL_CWD));
  await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();
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
