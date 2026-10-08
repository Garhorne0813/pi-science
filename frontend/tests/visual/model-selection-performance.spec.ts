import { writeFile } from "node:fs/promises";
import { expect, test } from "./fixtures/app.fixture";
import { FIXTURES } from "./fixtures/data.mjs";

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
