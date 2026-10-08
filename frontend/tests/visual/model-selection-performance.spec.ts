import { writeFile } from "node:fs/promises";
import { expect, test, workspaceRoute } from "./fixtures/app.fixture";
import { FIXTURES, VISUAL_CWD, VISUAL_SESSION } from "./fixtures/data.mjs";

test("10,000-model default picker stays responsive while context settings stall or fail", async ({ page }, testInfo) => {
  const models = Array.from({ length: 10000 }, (_, index) => ({ ...FIXTURES.config.available_models[0], id: `user-perf/model-${String(index).padStart(5, "0")}`, provider: "user-perf", model: `model-${index}`, label: `Model ${String(index).padStart(5, "0")}`, custom: true, thinking_levels: ["off", "high"] }));
  let defaults = { model: models[0].id, thinking: "off" };
  let writes = 0;
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/settings/config*", async (route) => { await stalled; await route.fulfill({ status: 400, json: { error: "context offline" } }); });
  await page.route("**/api/model-selection/catalog*", (route) => route.fulfill({ json: { available_models: models } }));
  await page.route("**/api/model-selection/default", async (route) => {
    if (route.request().method() === "PUT") { defaults = route.request().postDataJSON(); writes++; }
    await route.fulfill({ json: { scope: "default", selection: defaults } });
  });
  await page.goto("/settings");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByRole("button", { name: "Light", exact: true })).toBeVisible();
  await page.evaluate(() => {
    type Profile = Window & { selectionTasks: number[]; selectionObserver: PerformanceObserver };
    const target = window as unknown as Profile;
    if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) throw new Error("Long Tasks support is required");
    target.selectionTasks = [];
    target.selectionObserver = new PerformanceObserver((list) => target.selectionTasks.push(...list.getEntries().map((entry) => entry.duration)));
    target.selectionObserver.observe({ type: "longtask" });
  });
  const agentStart = Date.now();
  await dialog.getByRole("tab", { name: "Agent", exact: true }).click();
  const trigger = dialog.getByRole("button", { name: /^Default model:/ });
  await expect(trigger).toBeEnabled();
  const agentReadyMs = Date.now() - agentStart;
  await expect(dialog.getByText("Loading context settings…", { exact: true })).toBeVisible();
  await trigger.click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(50);
  const searchStart = Date.now();
  await page.getByRole("textbox", { name: /Search models/ }).pressSequentially("Model 09999", { delay: 20 });
  await expect(page.getByRole("menuitemradio")).toHaveCount(1);
  const searchReadyMs = Date.now() - searchStart;
  await page.getByRole("menuitemradio", { name: "Model 09999", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByText("Default model saved", { exact: true })).toBeVisible();
  expect(defaults.model).toBe(models[9999].id);
  expect(writes).toBe(1);
  // The acknowledged selection stays committed even when the optional
  // compatibility/context projection subsequently fails.
  release();
  await expect(dialog.getByText(/Default model saved. Context settings could not refresh/)).toBeVisible();
  await expect(trigger).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await trigger.click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(50);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  const longTasks = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const target = window as unknown as Window & { selectionTasks: number[]; selectionObserver: PerformanceObserver };
    target.selectionTasks.push(...target.selectionObserver.takeRecords().map((entry) => entry.duration));
    target.selectionObserver.disconnect();
    return target.selectionTasks;
  });
  const metrics = { models: models.length, agentReadyMs, searchReadyMs, maxLongTaskMs: Math.max(0, ...longTasks), totalLongTaskMs: longTasks.reduce((sum, duration) => sum + duration, 0), longTasks };
  const budgets = { agentReadyMs: 2000, searchReadyMs: 2000, maxLongTaskMs: 250, totalLongTaskMs: 1000 };
  const artifact = testInfo.outputPath("default-selection-performance.json");
  await writeFile(artifact, JSON.stringify({ metrics, budgets }, null, 2));
  await testInfo.attach("default-selection-performance", { path: artifact, contentType: "application/json" });
  for (const [key, budget] of Object.entries(budgets)) expect(metrics[key as keyof typeof budgets], `${key} exceeds ${budget}ms budget`).toBeLessThanOrEqual(budget);
  await dialog.screenshot({ path: testInfo.outputPath("default-selection-independent.png"), animations: "disabled" });
});


test("10,000-model Composer menu limits mounted items and meets interaction budgets", async ({ page }, testInfo) => {
  const models = Array.from({ length: 10000 }, (_, index) => ({ ...FIXTURES.config.available_models[0], id: `user-perf-${index % 100}/model-${index}`, provider: `user-perf-${index % 100}`, model: `model-${index}`, label: `Model ${index}`, custom: true, thinking_levels: ["off", "high"] }));
  let session = { model: models[0].id, thinking: "off" };
  let writes = 0;
  await page.route("**/api/model-selection/catalog*", (route) => route.fulfill({ json: { available_models: models } }));
  await page.route(`**/api/sessions/${VISUAL_SESSION}/model-selection*`, async (route) => {
    if (route.request().method() === "PUT") { session = route.request().postDataJSON(); writes++; }
    await route.fulfill({ json: { scope: "session", session_id: VISUAL_SESSION, selection: session } });
  });
  await page.route(`**/api/sessions/${VISUAL_SESSION}/state*`, (route) => route.fulfill({ json: { ...FIXTURES.sessionState, ...session } }));
  await page.goto(workspaceRoute(VISUAL_CWD, `/session/${VISUAL_SESSION}`));
  const composer = page.getByRole("button", { name: "Select model and thinking level and view context", exact: true });
  await expect(composer).toContainText("model-0");
  await page.evaluate(() => {
    const target = window as unknown as Window & { composerTasks: number[]; composerObserver: PerformanceObserver };
    if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) throw new Error("Long Tasks support is required");
    target.composerTasks = [];
    target.composerObserver = new PerformanceObserver((list) => target.composerTasks.push(...list.getEntries().map((entry) => entry.duration)));
    target.composerObserver.observe({ type: "longtask" });
  });
  const openStart = Date.now();
  await composer.click();
  await page.getByRole("menuitem", { name: /^Model/ }).click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(50);
  const submenu = page.getByRole("menu").filter({ has: page.getByRole("textbox", { name: "Search models", exact: true }) });
  const bounds = await submenu.boundingBox();
  expect(bounds).not.toBeNull();
  // Follow a real pointer path through Radix's submenu grace area before
  // clicking a control far from the parent trigger.
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2, { steps: 10 });
  const openReadyMs = Date.now() - openStart;
  const pageStart = Date.now();
  await page.getByRole("menuitem", { name: "Next", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name: "model-50", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitemradio")).toHaveCount(50);
  const pageReadyMs = Date.now() - pageStart;
  const searchStart = Date.now();
  await page.getByRole("textbox", { name: "Search models", exact: true }).pressSequentially("model-9999", { delay: 20 });
  await expect(page.getByRole("menuitemradio")).toHaveCount(1);
  const searchReadyMs = Date.now() - searchStart;
  await page.getByRole("menuitemradio", { name: "model-9999", exact: true }).click();
  await expect(composer).toContainText("model-9999");
  await expect.poll(() => writes).toBe(1);
  const tasks = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const target = window as unknown as Window & { composerTasks: number[]; composerObserver: PerformanceObserver };
    target.composerTasks.push(...target.composerObserver.takeRecords().map((entry) => entry.duration));
    target.composerObserver.disconnect();
    return target.composerTasks;
  });
  const metrics = { models: models.length, openReadyMs, pageReadyMs, searchReadyMs, maxLongTaskMs: Math.max(0, ...tasks), totalLongTaskMs: tasks.reduce((sum, value) => sum + value, 0) };
  const budgets = { openReadyMs: 2000, pageReadyMs: 1500, searchReadyMs: 2000, maxLongTaskMs: 250, totalLongTaskMs: 1000 };
  const artifact = testInfo.outputPath("composer-model-performance.json");
  await writeFile(artifact, JSON.stringify({ metrics, budgets, longTasks: tasks }, null, 2));
  await testInfo.attach("composer-model-performance", { path: artifact, contentType: "application/json" });
  for (const [key, budget] of Object.entries(budgets)) expect(metrics[key as keyof typeof budgets], `${key} exceeds ${budget}ms`).toBeLessThanOrEqual(budget);
});
