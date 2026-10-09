import { expect, test, workspaceRoute } from "./fixtures/app.fixture";
import { FIXTURES, VISUAL_CWD, VISUAL_SESSION } from "./fixtures/data.mjs";

test("Settings defaults and Composer session selection remain independent", async ({ page }, testInfo) => {
  let defaults = { model: "deepseek/deepseek-chat", thinking: "off" };
  let session = { ...defaults };
  let defaultWrites = 0;
  let sessionWrites = 0;
  await page.route("**/api/model-selection/default", async (route) => {
    if (route.request().method() === "PUT") { defaults = route.request().postDataJSON(); defaultWrites++; }
    await route.fulfill({ json: { scope: "default", selection: defaults } });
  });
  await page.route("**/api/settings/config*", (route) => route.fulfill({ json: { ...FIXTURES.config, ...defaults } }));
  await page.route(`**/api/sessions/${VISUAL_SESSION}/model-selection*`, async (route) => {
    if (route.request().method() === "PUT") { session = route.request().postDataJSON(); sessionWrites++; }
    await route.fulfill({ json: { scope: "session", session_id: VISUAL_SESSION, selection: session } });
  });
  await page.route(`**/api/sessions/${VISUAL_SESSION}/state*`, (route) => route.fulfill({ json: { ...FIXTURES.sessionState, ...session } }));
  await page.goto("/settings");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("tab", { name: "Agent", exact: true }).click();
  const model = dialog.getByRole("button", { name: /^Default model:/ });
  await expect(model).toContainText("DeepSeek Chat");
  await model.click();
  await page.getByRole("menuitemradio", { name: "DeepSeek Reasoner", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  expect(defaultWrites).toBe(0);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect.poll(() => defaultWrites).toBe(1);
  expect(session).toEqual({ model: "deepseek/deepseek-chat", thinking: "off" });
  await dialog.screenshot({ path: testInfo.outputPath("model-selection-default.png"), animations: "disabled" });
  await page.goto(workspaceRoute(VISUAL_CWD, `/session/${VISUAL_SESSION}`));
  const composer = page.getByRole("button", { name: "Select model and thinking level and view context", exact: true });
  await expect(composer).toContainText("deepseek-chat");
  await composer.click();
  await page.getByRole("menuitem", { name: /^Model/ }).click();
  const submenu = page.getByRole("menu").filter({ has: page.getByRole("textbox", { name: "Search models", exact: true }) });
  await expect(submenu).toBeVisible();
  const bounds = await submenu.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: testInfo.outputPath("composer-model-menu.png"), animations: "disabled" });
  await page.getByRole("menuitemradio", { name: "deepseek-reasoner", exact: true }).click();
  await expect(composer).toContainText("deepseek-reasoner");
  await expect.poll(() => sessionWrites).toBe(1);
  await expect.poll(() => defaultWrites).toBe(1);
  expect(defaults).toEqual({ model: "deepseek/deepseek-reasoner", thinking: "off" });
  // Changing only session thinking makes the separation visible despite the
  // model IDs now matching.
  await composer.click();
  await page.getByRole("menuitem", { name: /^Effort/ }).click();
  await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
  await expect(composer).toContainText("High");
  await expect.poll(() => session.thinking).toBe("high");
  expect(defaults.thinking).toBe("off");
  await page.goto("/settings");
  await dialog.getByRole("tab", { name: "Agent", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /^Thinking Level:/ })).toContainText("Off");
});
