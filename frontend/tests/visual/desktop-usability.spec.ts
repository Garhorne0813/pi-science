import { expect, test, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD } from "./fixtures/data.mjs";
import { settingsSchema } from "@pi-science/contracts";

test.beforeEach(async ({ page }, info) => { void page; test.skip(!info.project.name.startsWith("desktop"), "Desktop usability acceptance"); });

test("file load failure is not an empty folder and keyboard actions remain visible", async ({ page }, info) => {
  let failed = true;
  await page.route(/\/api\/files\?/, route => failed ? route.fulfill({ status: 503, json: { error: "Offline" } }) : route.fulfill({ json: [{ name: "研究样本_重复测量_2026_最终版本.csv", path: "study.csv", isDir: false, size: 24, modified: 1786795200 }] }));
  await page.goto(workspaceRoute(VISUAL_CWD, "/files"));
  const main = page.locator("#main-content");
  await expect(main.getByRole("alert")).toBeVisible();
  await expect(main.getByText("This directory is empty", { exact: false })).toHaveCount(0);
  failed = false;
  await main.getByRole("button", { name: "Retry", exact: true }).click();
  const file = main.getByRole("button", { name: "研究样本_重复测量_2026_最终版本.csv", exact: true });
  await expect(file).toBeVisible();
  await file.focus();
  await page.keyboard.press("Tab");
  const remove = main.getByRole("button", { name: "Delete", exact: true });
  await expect(remove).toBeFocused();
  await expect(remove).toHaveCSS("opacity", "1");
  await page.screenshot({ path: info.outputPath("files-keyboard.png") });
});

test("memory errors keep unknown counts and offer section retry", async ({ page }) => {
  await page.route("**/api/memory/records?*", route => route.fulfill({ status: 503, json: { error: "Offline" } }));
  await page.route("**/api/memory/reviews?*", route => route.fulfill({ status: 503, json: { error: "Offline" } }));
  await page.goto(workspaceRoute(VISUAL_CWD, "/memory"));
  await expect(page.getByRole("alert").filter({ hasText: "Could not load Memories" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pending review (Unavailable)", exact: true })).toBeVisible();
  await expect(page.getByText("0 memories", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
});

test("memory settings draft survives navigation and save stays in the desktop viewport", async ({ page }, info) => {
  await page.route("**/api/memory/settings*", route => route.fulfill({ json: { ...settingsSchema.parse({ enabled: true }), revision: 1 } }));
  await page.goto(workspaceRoute(VISUAL_CWD, "/memory"));
  await page.getByRole("button", { name: "Memory settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("spinbutton", { name: "Daily token limit", exact: true }).fill("12345");
  await dialog.getByRole("tab", { name: "General", exact: true }).click();
  await dialog.getByRole("tab", { name: "Memory", exact: true }).click();
  await expect(dialog.getByRole("spinbutton", { name: "Daily token limit", exact: true })).toHaveValue("12345");
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeInViewport({ ratio: 1 });
  await expect(save).toBeEnabled();
  await page.screenshot({ path: info.outputPath("settings-draft.png") });
  await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(save).toBeDisabled();
});

test("discard confirmation traps focus and Escape preserves the underlying memory editor", async ({ page }) => {
  await page.goto(workspaceRoute(VISUAL_CWD, "/memory"));
  await page.getByRole("button", { name: "Create memory", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Create memory", exact: true });
  await editor.getByRole("textbox", { name: "Title", exact: true }).fill("Unsaved draft");
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirmation.getByRole("button", { name: "Discard changes", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Unsaved draft");
  await expect(editor.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await confirmation.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(editor).toHaveCount(0);
});
