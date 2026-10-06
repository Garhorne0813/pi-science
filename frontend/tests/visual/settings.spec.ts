import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures/app.fixture";
import { FIXTURES } from "./fixtures/data.mjs";

test("settings navigation, model facts and saved compaction across viewports", async ({ page }, testInfo) => {
  let threshold = 70;
  let enabled = true;
  await page.route("**/api/settings/config*", (route) => route.fulfill({ json: {
    ...FIXTURES.config, compaction_threshold_percent: threshold, compaction_enabled: enabled,
    providers: [...FIXTURES.config.providers, { id: "subscription", name: "Subscription service", models: [], has_key: true, credential_status: "connected", auth: { kind: "oauth", api_key_supported: false, oauth_supported: true, login_supported: false } }],
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
    await expect(dialog.getByRole("heading", { name: tab, exact: true })).toBeVisible();
    const violations = (await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations.filter((item) => item.impact === "critical" || item.impact === "serious");
    expect(violations, `${tab} accessibility`).toEqual([]);
    expect(await dialog.getByRole("tabpanel").evaluate((element) => element.scrollWidth <= element.clientWidth + 1), `${tab} must fit the viewport`).toBe(true);
    await dialog.screenshot({ path: testInfo.outputPath(`${tab.replaceAll(" ", "-").toLowerCase()}.png`), animations: "disabled" });
    if (tab === "AI Models") {
      await expect(dialog.getByText("Login required", { exact: true })).toBeVisible();
      const search = dialog.getByRole("searchbox");
      await search.fill("nonexistent-model");
      await expect(dialog.getByText("No services or models match your search.")).toBeVisible();
      await dialog.getByRole("button", { name: "Clear", exact: true }).click();
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
