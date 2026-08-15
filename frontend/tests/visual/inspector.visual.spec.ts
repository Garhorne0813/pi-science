/** Inspector visual baselines: opening a workspace file from the sidebar and
 *  the markdown preview on the right side. */

import { expect, screenshot, test, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD } from "./fixtures/data.mjs";

async function openSidebarFile(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo) {
  // The mobile project renders the collapsed rail without the file browser,
  // so the sidebar file-open flow is exercised on desktop/tablet/wide only.
  test.skip(testInfo.project.name === "mobile", "mobile rail hides the file browser");
  await page.goto(workspaceRoute(VISUAL_CWD));
  await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();
  await page.getByRole("button", { name: /report\.md/ }).first().click();
}

test("sidebar file opens the inspector with a markdown preview", async ({ page }, testInfo) => {
  await openSidebarFile(page, testInfo);
  await expect(page.locator('[data-variant="file"]')).toBeVisible();
  await expect(page.getByText("Fold change report")).toBeVisible();
  await screenshot(page, "inspector-file-preview.png");
});

test("inspector stays usable when the composer is present", async ({ page }, testInfo) => {
  await openSidebarFile(page, testInfo);
  await expect(page.locator('[data-variant="file"]')).toBeVisible();
  await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();
  await screenshot(page, "inspector-with-composer.png");
});
