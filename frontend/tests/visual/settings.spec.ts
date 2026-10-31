import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures/app.fixture";
import { FIXTURES } from "./fixtures/data.mjs";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/settings/approval", route => route.fulfill({ json: { defaultMode: "ask" } }));
});

test("settings navigation, model facts and saved compaction across viewports", async ({ page }, testInfo) => {
  let threshold = 70;
  let enabled = true;
  await page.route("**/api/settings/config*", (route) => route.fulfill({ json: {
    ...FIXTURES.config, compaction_threshold_percent: threshold, compaction_enabled: enabled,
    providers: [...FIXTURES.config.providers, { id: "subscription", name: "Subscription service", models: [], has_key: true, credential_status: "connected" as const, auth: { kind: "oauth" as const, api_key_supported: false, oauth_supported: true, login_supported: false } }],
  } }));
  await page.route("**/api/settings/compaction*", async (route) => {
    const body = route.request().postDataJSON();
    threshold = body.threshold_percent;
    enabled = body.enabled;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/settings");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByRole("button", { name: "Light", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  for (const tab of ["General", "AI Models", "Agent"]) {
    await dialog.getByRole("tab", { name: tab, exact: true }).click();
    await expect(dialog.getByRole("heading", { name: tab === "General" ? "General & appearance" : tab, exact: true })).toBeVisible();
    // Default selection is fetched independently from the Settings shell.
    // Audit the ready control, rather than racing its disabled loading state.
    if (tab === "Agent") {
      const clearDefault = dialog.getByRole("button", { name: "Clear default model", exact: true });
      await expect(clearDefault).toBeEnabled();
      await expect(clearDefault).toHaveCSS("opacity", "1");
    }
    const violations = (await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations.filter((item) => item.impact === "critical" || item.impact === "serious");
    expect(violations, `${tab} accessibility`).toEqual([]);
    expect(await dialog.getByRole("tabpanel").evaluate((element) => element.scrollWidth <= element.clientWidth + 1), `${tab} must fit the viewport`).toBe(true);
    await dialog.screenshot({ path: testInfo.outputPath(`${tab.replaceAll(" ", "-").toLowerCase()}.png`), animations: "disabled" });
    if (tab === "AI Models") {
      await expect(dialog.getByRole("button", { name: "DeepSeek", exact: true })).toBeVisible();
      const search = dialog.getByRole("textbox", { name: /Search/ });
      await search.fill("nonexistent-model");
      await expect(dialog.getByText("No services or models match your search.")).toBeVisible();
      await dialog.getByRole("button", { name: "Clear search", exact: true }).click();
      await dialog.getByRole("button", { name: "DeepSeek", exact: true }).click();
      await expect(dialog.getByText("DeepSeek Reasoner", { exact: false })).toBeVisible();
    }
  }
  await dialog.getByRole("slider").fill("80");
  await expect(dialog.getByText("51,200 tokens", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Save context settings", exact: true }).click();
  await expect(dialog.getByText("Settings saved", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save context settings", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Manage models", exact: true }).click();
  await expect(dialog.getByRole("tab", { name: "AI Models", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("native model catalog failures recover without showing an empty inventory", async ({ page }) => {
  let failed = true;
  await page.route("**/api/model-config/catalog", async route => {
    if (failed) await route.fulfill({ status: 503, json: { error: "Catalog unavailable" } });
    else await route.continue();
  });
  await page.goto("/settings");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("tab", { name: "AI Models", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Catalog unavailable");
  failed = false;
  await dialog.getByRole("button", { name: "Retry loading", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "DeepSeek", exact: true })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("Agent owns built-in capability guidance", async ({ page }, testInfo) => {
  const obsoleteRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(settings\/(extensions)|agent-profiles)/.test(request.url())) obsoleteRequests.push(request.url());
  });
  await page.goto("/settings");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("tab", { name: "Agent", exact: true }).click();
  await dialog.locator("summary").filter({ hasText: "Built-in tools" }).click();
  await expect(dialog.getByText(/no Pi extension installation is required/)).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Extensions", exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Installed Extensions", { exact: true })).toHaveCount(0);
  expect(await dialog.getByRole("tabpanel").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const violations = (await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations.filter((item) => item.impact === "critical" || item.impact === "serious");
  expect(violations).toEqual([]);
  await dialog.screenshot({ path: testInfo.outputPath("agent-capabilities.png"), animations: "disabled" });
  await dialog.getByRole("tab", { name: "MCP", exact: true }).click();
  await expect(dialog.getByRole("tab", { name: "MCP", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(obsoleteRequests).toEqual([]);
});

test("native web search settings save provider credentials and switches @accessibility", async ({ page }, testInfo) => {
  let settings = { search_enabled: true, fetch_enabled: true, provider: "auto", api_keys: {} as Record<string, boolean> };
  const writes: Array<Record<string, unknown>> = [];
  await page.route("**/api/settings/web-access", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON(); writes.push(body);
      settings = { ...settings, ...body, api_keys: { ...settings.api_keys, ...Object.fromEntries(Object.entries(body.api_keys ?? {}).map(([name, key]) => [name, Boolean(key)])) } };
    }
    await route.fulfill({ json: { ok: true, web_access: settings, session_replacements: [] } });
  });
  await page.goto("/settings");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("tab", { name: "Web access", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: "Enable web search" })).toBeChecked();
  await dialog.getByRole("button", { name: /^Search provider:/ }).click();
  await page.getByRole("menuitemradio", { name: "Brave", exact: true }).click();
  await dialog.getByLabel("API key", { exact: true }).fill("fixture-key");
  await dialog.getByRole("checkbox", { name: "Enable web search" }).uncheck();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByText("Settings saved", { exact: true })).toBeVisible();
  expect(writes).toEqual([{ search_enabled: false, fetch_enabled: true, provider: "brave", api_keys: { brave: "fixture-key" } }]);
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("");
  expect(await dialog.getByRole("tabpanel").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const violations = (await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations.filter(item => item.impact === "critical" || item.impact === "serious");
  expect(violations).toEqual([]);
  await dialog.screenshot({ path: testInfo.outputPath("web-search-settings.png"), animations: "disabled" });
});


test("settings switches preserve drafts across tabs and expose only applicable controls", async ({ page }) => {
  await page.route("**/api/settings/web-access", route => route.fulfill({ json: { web_access: { search_enabled: true, fetch_enabled: true, provider: "brave", api_keys: {} } } }));
  await page.goto("/settings");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByRole("tab", { name: "Agent Capabilities", exact: true })).toHaveCount(0);
  await dialog.getByRole("tab", { name: "Web access", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "Enable web search", exact: true }).uncheck();
  await expect(dialog.getByLabel("API key", { exact: true })).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Enable webpage and PDF reading", exact: true }).uncheck();
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("tab", { name: "Web access", exact: true }).locator('[title="Unsaved changes"]')).toBeVisible();
  await dialog.getByRole("tab", { name: "Agent", exact: true }).click();
  const compact = dialog.getByRole("checkbox", { name: "Automatic compaction", exact: true });
  await compact.uncheck();
  await expect(dialog.getByRole("slider")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Save context settings", exact: true })).toBeEnabled();
  await dialog.getByRole("tab", { name: "Web access", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: "Enable web search", exact: true })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: "Enable web search", exact: true })).toBeChecked();
  await dialog.getByRole("tab", { name: "Agent", exact: true }).click();
  await expect(compact).not.toBeChecked();
  await expect(dialog.getByRole("tab", { name: "Web access", exact: true }).locator('[title="Unsaved changes"]')).toHaveCount(0);
  await expect(dialog.getByRole("tab", { name: "Agent", exact: true }).locator('[title="Unsaved changes"]')).toBeVisible();
});
