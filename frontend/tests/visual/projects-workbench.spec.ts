import { expect, test } from "./fixtures/app.fixture";
import { FIXTURES } from "./fixtures/data.mjs";

test("empty workbench opens global settings from its header", async ({ page }, testInfo) => {
  await page.route("**/api/workspaces", route => route.fulfill({ json: [] }));
  await page.goto("/");
  await expect(page.getByText("No projects yet", { exact: true })).toBeVisible();
  await expect(page.locator('nav[aria-label="Primary navigation"]')).toHaveCount(0);
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  expect(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("empty-workbench.png"), fullPage: true });
  await settings.click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog.getByRole("tab", { name: "General", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Light", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(settings).toHaveAttribute("aria-expanded", "false");
});

test("workbench rename and delete remain usable", async ({ page }, testInfo) => {
  let workspaces = structuredClone(FIXTURES.workspaces);
  const original = workspaces[0];
  await page.route("**/api/workspaces", route => route.fulfill({ json: workspaces }));
  await page.route("**/api/workspaces/rename", async route => {
    expect(route.request().postDataJSON()).toEqual({ path: original.path, name: "Renamed Study" });
    workspaces = workspaces.map(workspace => workspace.path === original.path ? { ...workspace, name: "Renamed Study" } : workspace);
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/workspaces/delete", async route => {
    expect(route.request().method()).toBe("DELETE");
    expect(route.request().postDataJSON()).toEqual({ path: original.path });
    workspaces = workspaces.filter(workspace => workspace.path !== original.path);
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const card = page.locator("article").filter({ has: page.getByRole("link", { name: `Open ${original.name}`, exact: true }) });
  await expect(card).toBeVisible();
  expect(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("workbench.png"), fullPage: true });
  await card.getByRole("button", { name: "Rename", exact: true }).click();
  await card.getByRole("textbox", { name: "Rename", exact: true }).fill("Renamed Study");
  await card.getByRole("textbox", { name: "Rename", exact: true }).press("Enter");
  const renamed = page.locator("article").filter({ has: page.getByRole("link", { name: "Open Renamed Study", exact: true }) });
  await expect(renamed).toBeVisible();
  await renamed.getByRole("button", { name: "Delete project?", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(renamed).toHaveCount(0);
});
