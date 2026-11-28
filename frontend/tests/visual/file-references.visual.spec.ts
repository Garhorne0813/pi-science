import { expect, screenshot, test, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_ACTIVITY_SESSION, VISUAL_CWD } from "./fixtures/data.mjs";

test("file references stay scoped to their conversation and remain visible in the tree", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "One desktop baseline is sufficient for this focused workflow.");
  await page.goto(workspaceRoute(VISUAL_CWD, `/session/${VISUAL_ACTIVITY_SESSION}`));
  await expect(page.getByText("Validation recovered after one retry.")).toBeVisible();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${VISUAL_ACTIVITY_SESSION}$`));

  const tree = page.getByRole("region", { name: "Workspace file tree" }).getByRole("tree");
  const readme = tree.getByRole("button", { name: "README.md" });
  await expect(readme).toBeVisible();
  await readme.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reference file" }).click();

  await tree.getByRole("button", { name: "data" }).click();
  const measurements = tree.getByRole("button", { name: "shikimate.csv" });
  await measurements.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reference file" }).click();

  await expect(readme).toHaveAttribute("data-referenced", "true");
  await expect(measurements).toHaveAttribute("data-referenced", "true");
  await expect(page.getByLabel("Remove reference README.md")).toBeVisible();
  await expect(page.getByLabel("Remove reference shikimate.csv")).toBeVisible();

  await readme.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Remove file reference" })).toBeVisible();
  await screenshot(page, "file-references.png");

});
