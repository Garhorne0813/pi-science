/** Accessibility gate for the visual suite (tagged @accessibility).
 *
 *  Runs axe-core against the four core surfaces. Any critical/serious
 *  violation fails the run. No rule ids are exempted; the former
 *  `color-contrast` debt (accent/muted tokens below WCAG AA) and the
 *  `scrollable-region-focusable` code-block gap were fixed by the
 *  integration pass (accent-fill token split + muted text bump +
 *  focusable <pre>).
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD, VISUAL_SESSION } from "./fixtures/data.mjs";

async function expectNoSeriousViolations(
  page: import("@playwright/test").Page,
  label: string,
) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === "critical" || violation.impact === "serious",
  );
  expect(
    serious,
    `${label}: unexpected critical/serious axe violations:\n`
    + serious.map((v) => `- ${v.id}: ${v.help} (${v.nodes.length} node(s))`).join("\n"),
  ).toEqual([]);
}

test("projects page has no serious axe violations @accessibility", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Visual Demo", { exact: true })).toBeVisible();
  await expectNoSeriousViolations(page, "projects page");
});

test("workspace landing has no serious axe violations @accessibility", async ({ page }) => {
  await page.goto(workspaceRoute(VISUAL_CWD));
  await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();
  await expectNoSeriousViolations(page, "workspace landing");
});

test("conversation has no serious axe violations @accessibility", async ({ page }) => {
  await page.goto(workspaceRoute(VISUAL_CWD, `/session/${VISUAL_SESSION}`));
  await expect(page.getByRole("heading", { name: "Shikimate pathway analysis" })).toBeVisible();
  await expectNoSeriousViolations(page, "conversation");
});

test("settings dialog has no serious axe violations @accessibility", async ({ page }) => {
  await page.goto(workspaceRoute(VISUAL_CWD));
  await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expectNoSeriousViolations(page, "settings dialog");
});
