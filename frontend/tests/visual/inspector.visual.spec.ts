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
  // Show the Context Panel's Files tab, then open the fixture file from its
  // embedded tree. Scoping to the panel element guarantees the click lands on
  // the real file browser row, not on the conversation's artifact strip
  // (which would render report.md without the panel being involved).
  const sidebar = page.locator("#workspace-context-panel");
  // The Files entry is a Context Panel tab, not a navigation button, and the
  // embedded tree replaced the old collapsible section header.
  await sidebar.getByRole("tab", { name: "Files", exact: true }).click();
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
