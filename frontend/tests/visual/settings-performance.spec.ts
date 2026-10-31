import { expect, test } from "./fixtures/app.fixture";
import { writeFile } from "node:fs/promises";

test("Settings isolates delayed model loading and bounds a 10,000-model catalog", async ({ page }, testInfo) => {
  const providers = Array.from({ length: 100 }, (_, index) => ({ id: `user-lab${index}`, name: `Lab ${index}`, revision: 0, editable: true, legacy: false, configured: true, source: "user", auth_capabilities: { api_key: true, environment: true, keyless: true, subscription: false }, allowed_actions: ["credential", "edit", "refresh", "details", "disconnect"], config: {}, authentication: { source: "managed", resolved: true }, models: Array.from({ length: 100 }, (_, model) => ({ id: `model-${index}-${model}`, name: `Model ${index}-${model}`, available: true, contextWindow: 65536, source: "configured" })) }));
  await page.route("**/api/model-config", (route) => route.fulfill({ json: { backend: "pi_ai_v1", revision: 0, config: { providers: {} }, providers: [] } }));
  let requests = 0;
  let release!: () => void;
  const delay = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/model-config/catalog", async (route) => {
    requests++;
    await delay;
    await route.fulfill({ json: { providers, revision: 0 } });
  });
  const opened = Date.now();
  await page.goto("/settings");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByRole("button", { name: "Light", exact: true })).toBeVisible();
  const generalReadyMs = Date.now() - opened;
  expect(requests).toBe(0);
  await dialog.getByRole("tab", { name: "AI Models", exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await dialog.getByRole("tab", { name: "General & appearance", exact: true }).click();
  await dialog.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Dark", exact: true })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("tab", { name: "Progress", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Reset", exact: true })).toBeVisible();
  expect(requests).toBe(1);
  const longTaskSupported = await page.evaluate(() => {
    type ProfiledWindow = Window & { settingsLongTasks: number[]; settingsObserver: PerformanceObserver };
    const target = window as unknown as ProfiledWindow;
    target.settingsLongTasks = [];
    if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) return false;
    target.settingsObserver = new PerformanceObserver((list) => {
      target.settingsLongTasks.push(...list.getEntries().map((entry) => entry.duration));
    });
    target.settingsObserver.observe({ type: "longtask" });
    return true;
  });
  expect(longTaskSupported, "Chromium must expose Long Tasks for this regression").toBe(true);
  const catalogStart = Date.now();
  release();
  await dialog.getByRole("tab", { name: "AI Models", exact: true }).click();
  await dialog.getByRole("button", { name: "Lab 0", exact: true }).click();
  await expect(dialog.getByText("Model 0-0", { exact: false })).toBeVisible();
  const catalogReadyMs = Date.now() - catalogStart;
  await expect(dialog.getByRole("button", { name: /Lab \d+ actions/ })).toHaveCount(20);
  await expect(dialog.getByRole("region").locator(".border-b")).toHaveCount(50);
  await dialog.getByRole("region", { name: "Lab 0 models", exact: true }).getByRole("button", { name: "Next", exact: true }).click();
  await expect(dialog.getByText("Model 0-50", { exact: false })).toBeVisible();
  await expect(dialog.getByText("Model 0-0", { exact: false })).toHaveCount(0);
  const searchStart = Date.now();
  await dialog.getByRole("textbox", { name: /Search/ }).pressSequentially("model-99-99", { delay: 20 });
  await expect(dialog.getByText("Lab 99", { exact: true })).toBeVisible();
  const searchReadyMs = Date.now() - searchStart;
  await expect(dialog.getByRole("button", { name: /Lab \d+ actions/ })).toHaveCount(1);
  await dialog.getByRole("button", { name: "Lab 99", exact: true }).click();
  await expect(dialog.getByText("Model 99-99", { exact: false })).toBeVisible();
  await dialog.getByRole("textbox", { name: /Search/ }).fill("");
  if (await dialog.getByRole("button", { name: "Lab 0", exact: true }).getAttribute("aria-expanded") !== "true") await dialog.getByRole("button", { name: "Lab 0", exact: true }).click();
  await expect(dialog.getByText("Model 0-0", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("region").locator(".border-b")).toHaveCount(50);
  expect(await dialog.getByRole("tabpanel").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const longTasks = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const target = window as unknown as Window & { settingsLongTasks: number[]; settingsObserver: PerformanceObserver };
    target.settingsLongTasks.push(...target.settingsObserver.takeRecords().map((entry) => entry.duration));
    target.settingsObserver.disconnect();
    return target.settingsLongTasks;
  });
  const metrics = { generalReadyMs, catalogReadyMs, searchReadyMs, maxLongTaskMs: Math.max(0, ...longTasks), totalLongTaskMs: longTasks.reduce((sum, duration) => sum + duration, 0), longTasks, providers: 100, models: 10000, visibleServiceCards: 20, visibleModelRows: 50 };
  // Production Chromium, one worker, no CPU throttling. These safety margins
  // catch substantial regressions; they are not 60-fps or real-network SLAs.
  const budgets = { generalReadyMs: 10000, catalogReadyMs: 1500, searchReadyMs: 2000, maxLongTaskMs: 250, totalLongTaskMs: 1000 };
  const artifact = testInfo.outputPath("settings-performance.json");
  await writeFile(artifact, JSON.stringify({ metrics, budgets }, null, 2));
  await testInfo.attach("settings-performance", { path: artifact, contentType: "application/json" });
  for (const [name, budget] of Object.entries(budgets)) expect(metrics[name as keyof typeof budgets], `${name} exceeds ${budget}ms budget`).toBeLessThanOrEqual(budget);
  await dialog.screenshot({ path: testInfo.outputPath("large-catalog.png"), animations: "disabled" });
});
