import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures/app.fixture";
import { providerViewsFixture } from "../fixtures/provider-views";
import { FIXTURES } from "./fixtures/data.mjs";

test("settings navigation, model facts and saved compaction across viewports", async ({ page }, testInfo) => {
  let threshold = 70;
  let enabled = true;
  await page.route("**/api/settings/config*", (route) => route.fulfill({ json: {
    ...FIXTURES.config, compaction_threshold_percent: threshold, compaction_enabled: enabled,
    providers: [...FIXTURES.config.providers, { id: "subscription", name: "Subscription service", models: [], has_key: true, credential_status: "connected" as const, auth: { kind: "oauth" as const, api_key_supported: false, oauth_supported: true, login_supported: false } }],
  } }));
  await page.route("**/api/provider-views*", (route) => route.fulfill({ json: providerViewsFixture({ ...FIXTURES.config, providers: [...FIXTURES.config.providers, { id: "subscription", name: "Subscription service", models: [], has_key: true, credential_status: "connected" as const, auth: { kind: "oauth" as const, api_key_supported: false, oauth_supported: true, login_supported: false } }] }) }));
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

test("repairs a provider with a lost binding without replacing its credential", async ({ page }) => {
  const inventory = providerViewsFixture(FIXTURES.config);
  const lab = structuredClone(inventory.providers.find((provider) => provider.credential.configured && provider.auth.api_key_supported)!);
  lab.id = "user-lab";
  lab.name = "Lab";
  lab.source = "user";
  lab.status = "unavailable";
  lab.allowed_actions = ["edit", "disable", "delete", "discover", "replace_credential"];
  lab.models = lab.models.slice(0, 1).map((model) => ({ ...model, id: `user-lab/${model.model_id}`, provider_id: "user-lab", available: false, availability_reason: "no_binding" }));
  lab.routing = { configured_model_count: 1, selectable_model_count: 0, issues: [{ code: "no_binding" }] };
  inventory.providers.push(lab);
  let repaired = false;
  await page.route("**/api/provider-views*", (route) => route.fulfill({ json: inventory }));
  await page.route("**/api/endpoints", (route) => route.fulfill({ json: { endpoints: [{ id: "endpoint-lab", owner_provider_id: "user-lab", name: "Lab endpoint", base_url: "https://lab.example/v1", credential_ref: "cred-lab", protocol: "openai" }] } }));
  await page.route("**/api/provider-endpoint-bindings", (route) => route.fulfill({ json: { bindings: repaired ? [{ id: "repaired-binding", provider_id: "user-lab", endpoint_id: "endpoint-lab" }] : [] } }));
  await page.route("**/api/custom-providers/user-lab", async (route) => {
    expect(route.request().method()).toBe("PUT");
    expect(route.request().postDataJSON()).toEqual({ name: "Lab", base_url: "https://lab.example/v1" });
    repaired = true;
    lab.status = "ready";
    lab.routing = { configured_model_count: 1, selectable_model_count: 1, issues: [] };
    lab.models[0].available = true;
    delete lab.models[0].availability_reason;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/settings");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "AI Models", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Model services", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: /^Lab 1 models/ }).click();
  await expect(settings.getByRole("region", { name: "Lab models", exact: true }).getByText("No enabled binding.", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Configure connection", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit connection" });
  await expect(editor.getByLabel("Base URL", { exact: true })).toHaveValue("https://lab.example/v1");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(repaired).toBe(true);
  await expect(settings.getByText("No enabled binding.", { exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "Available", exact: true }).click();
  await expect(settings.getByText("Lab", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "+ Connect", exact: true }).click();
  const connect = page.getByRole("dialog", { name: "Connect a model service" });
  for (const provider of inventory.providers.filter((provider) => provider.source === "builtin" && provider.credential.configured)) {
    await expect(connect.getByRole("button", { name: provider.name, exact: true })).toHaveCount(0);
  }
});


test("maintains a configured builtin key through its card while excluding it from Connect", async ({ page }) => {
  const inventory = providerViewsFixture(FIXTURES.config);
  const provider = inventory.providers.find((item) => item.source === "builtin" && item.credential.configured && item.allowed_actions.includes("replace_credential"))!;
  let saved = false;
  await page.route("**/api/provider-views*", (route) => route.fulfill({ json: { providers: [provider] } }));
  await page.route("**/api/settings/api-key", async (route) => {
    expect(route.request().method()).toBe("PUT");
    expect(route.request().postDataJSON()).toEqual({ provider: provider.id, api_key: "synthetic-replacement-key" });
    saved = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/settings");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "AI Models", exact: true }).click();
  await settings.getByRole("button", { name: "Connection settings", exact: true }).click();
  await settings.getByRole("menuitem", { name: "Replace", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Replace API key" });
  await editor.getByLabel(`${provider.name} API key`, { exact: false }).fill("synthetic-replacement-key");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(saved).toBe(true);
  await settings.getByRole("button", { name: "+ Connect", exact: true }).click();
  const connect = page.getByRole("dialog", { name: "Connect a model service" });
  await expect(connect.getByRole("button", { name: provider.name, exact: true })).toHaveCount(0);
});
