import { expect, test, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD, VISUAL_SESSION } from "./fixtures/data.mjs";

test("keeps focus in the search field while the narrow model list filters", async ({ page }) => {
  test.skip(test.info().project.name !== "mobile", "the panel replaces the menu below the sm breakpoint");
  await page.goto(workspaceRoute(VISUAL_CWD, `/session/${VISUAL_SESSION}`));
  await page.getByRole("button", { name: "Select model and thinking level and view context", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Model/ }).click();
  const search = page.getByRole("textbox", { name: "Search models", exact: true });
  await expect(search).toBeVisible();
  await expect(search).toBeFocused();
  await page.waitForTimeout(200);
  await search.pressSequentially("mode");
  await expect(search).toHaveValue("mode");
  await expect(search).toBeFocused();
});
