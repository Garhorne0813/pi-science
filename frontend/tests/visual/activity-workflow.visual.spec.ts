import { expect, screenshot, test, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_ACTIVITY_SESSION, VISUAL_CWD } from "./fixtures/data.mjs";

test("grouped tool workflow and retry attempt history", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "One desktop baseline is sufficient for this focused workflow.");
  await page.goto(workspaceRoute(VISUAL_CWD, `/session/${VISUAL_ACTIVITY_SESSION}`));
  await expect(page.getByText("Validation recovered after one retry.")).toBeVisible();
  await page.getByRole("button", { name: /^Completed · 35s/ }).click();

  await expect(page.getByRole("button", { name: "Explored · 3 operations" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Changed files · 2 operations" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ran validation · 2 operations" })).toBeVisible();
  await page.getByRole("button", { name: "Ran validation · 2 operations" }).click();
  await page.getByRole("button", { name: /^Run pipeline tests/ }).click();
  await expect(page.getByText("Attempt history")).toBeVisible();
  await expect(page.getByText("Attempt 1")).toBeVisible();
  await expect(page.getByText("Attempt 2")).toBeVisible();
  await screenshot(page, "activity-workflow.png");
});
