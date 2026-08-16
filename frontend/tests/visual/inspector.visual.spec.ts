/** Inspector visual baselines: opening a workspace file from the sidebar and
 *  the markdown preview on the right side. */

import { expect, screenshot, test, waitForConversationSettled, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD } from "./fixtures/data.mjs";

async function openSidebarFile(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo) {
  // The mobile project renders the collapsed rail without the file browser,
  // so the sidebar file-open flow is exercised on desktop/tablet/wide only.
  test.skip(testInfo.project.name === "mobile", "mobile rail hides the file browser");
  await page.goto(workspaceRoute(VISUAL_CWD));
  // The workspace root auto-navigates into the most recent session; the
  // thread must be fully settled before the sidebar interaction so the
  // captured baseline never shows a half-loaded conversation.
  await waitForConversationSettled(page);
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
  // The composer stays usable with the inspector open — the same state the
  // former separate file-preview / with-composer tests both captured. They
  // were fully redundant (identical layout and assertions on the settled
  // thread), so they are merged here instead of keeping fake coverage.
  await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();
  await screenshot(page, "inspector-file-preview.png");
});
