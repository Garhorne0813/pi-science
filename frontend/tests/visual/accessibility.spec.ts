/** Accessibility gate for the visual suite (tagged @accessibility).
 *
 *  Runs axe-core against the four core surfaces. Any critical/serious
 *  violation fails the run — EXCEPT the documented pre-existing
 *  `color-contrast` debt shipped by the foundation palette (design-token
 *  milestone, plan task 4, must bring the palette to WCAG AA and then remove
 *  the exclusion). New violation types are never exempted.
 *
 *  Known debt today (axe 4.13):
 *  - accent #4176e6 on white = 4.23:1 (< 4.5:1), #679efe on dark = 2.65:1
 *  - muted text #9ea1a5 on #f9fafb = 2.48:1, #898c90 on white = 3.37:1
 *  - scrollable-region-focusable on the markdown code block <pre> at narrow
 *    viewports (overflow-x scroll container without keyboard access; the
 *    Markdown/code-block milestone owns the fix).
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD, VISUAL_SESSION } from "./fixtures/data.mjs";

const KNOWN_PRE_EXISTING_RULE_IDS = ["color-contrast", "scrollable-region-focusable"];

async function expectNoSeriousViolations(
  page: import("@playwright/test").Page,
  label: string,
  testInfo: import("@playwright/test").TestInfo,
) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === "critical" || violation.impact === "serious",
  );
  const known = serious.filter((violation) => KNOWN_PRE_EXISTING_RULE_IDS.includes(violation.id));
  const unexpected = serious.filter((violation) => !KNOWN_PRE_EXISTING_RULE_IDS.includes(violation.id));
  if (known.length > 0) {
    testInfo.annotations.push({
      type: "known-a11y-debt",
      description: `${label}: ${known.map((v) => `${v.id} (${v.nodes.length})`).join(", ")}`,
    });
  }
  expect(
    unexpected,
    `${label}: unexpected critical/serious axe violations:\n`
    + unexpected.map((v) => `- ${v.id}: ${v.help} (${v.nodes.length} node(s))`).join("\n"),
  ).toEqual([]);
}

test("projects page has no serious axe violations @accessibility", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByText("Visual Demo", { exact: true })).toBeVisible();
  await expectNoSeriousViolations(page, "projects page", testInfo);
});

test("workspace landing has no serious axe violations @accessibility", async ({ page }, testInfo) => {
  await page.goto(workspaceRoute(VISUAL_CWD));
  await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();
  await expectNoSeriousViolations(page, "workspace landing", testInfo);
});

test("conversation has no serious axe violations @accessibility", async ({ page }, testInfo) => {
  await page.goto(workspaceRoute(VISUAL_CWD, `/session/${VISUAL_SESSION}`));
  await expect(page.getByRole("heading", { name: "Shikimate pathway analysis" })).toBeVisible();
  await expectNoSeriousViolations(page, "conversation", testInfo);
});

test("settings dialog has no serious axe violations @accessibility", async ({ page }, testInfo) => {
  await page.goto(workspaceRoute(VISUAL_CWD));
  await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expectNoSeriousViolations(page, "settings dialog", testInfo);
});
