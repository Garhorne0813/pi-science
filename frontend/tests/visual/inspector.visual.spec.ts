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
  // Expand the sidebar's file browser section, then open the fixture file
  // from the sidebar tree. Scoping to the <aside> guarantees the click lands
  // on the real file browser row, not on the conversation's artifact strip
  // (which would render report.md without the sidebar being involved).
  const sidebar = page.locator("aside");
  // Two buttons read "Files" in the sidebar: the navigation item and the
  // file-browser section header (nav renders first). Click the section header
  // to expand the browser, then open the fixture file from the sidebar tree.
  await sidebar.getByRole("button", { name: "Files", exact: true }).nth(1).click();
  const fileRow = sidebar.getByRole("button", { name: "report.md" });
  await expect(fileRow).toBeVisible();
  await fileRow.click();
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
