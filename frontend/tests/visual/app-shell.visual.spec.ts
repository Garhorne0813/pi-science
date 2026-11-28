/** App-shell visual baselines: projects page, workspace landing and the
 *  collapsible sidebar across the fixed viewport matrix. */

import { expect, screenshot, test, waitForConversationSettled, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD, VISUAL_LANDING_CWD } from "./fixtures/data.mjs";

test("projects page renders workspace cards", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Your projects" }).getByRole("link", { name: "Open Visual Demo", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Your projects" }).getByRole("link", { name: "Open Shikimate Project", exact: true })).toBeVisible();
  await screenshot(page, "projects.png");
});

test("workspace landing shows the hero composer", async ({ page }) => {
  // Dedicated session-free cwd: the mock server returns an empty session
  // list here, so nothing can redirect the workspace route into a session
  // and the page must render the true landing hero.
  await page.goto(workspaceRoute(VISUAL_LANDING_CWD));
  // Real landing hero: welcome copy plus the centered composer.
  const greeting = page.getByRole("heading", { name: "What are you researching today?" });
  const input = page.getByPlaceholder("Enter a research question or drop a data file", { exact: true });
  await expect(greeting).toBeVisible();
  await expect(input).toBeVisible();
  const { cardCenter, areaCenter, cardTop, cardMiddle } = await input.evaluate((element) => {
    const card = element.closest(".rounded-composer")!;
    const area = card.closest(".relative.flex.flex-1.flex-col")!;
    const cardBox = card.getBoundingClientRect();
    const areaBox = area.getBoundingClientRect();
    return {
      cardCenter: cardBox.left + cardBox.width / 2,
      areaCenter: areaBox.top + areaBox.height / 2,
      cardTop: cardBox.top,
      cardMiddle: cardBox.top + cardBox.height / 2,
    };
  });
  const headingBox = (await greeting.boundingBox())!;
  expect(headingBox.y + headingBox.height).toBeLessThan(cardTop);
  expect(Math.abs(headingBox.x + headingBox.width / 2 - cardCenter)).toBeLessThan(2);
  expect(Math.abs(cardMiddle - areaCenter)).toBeLessThan(2);
  // No auto-navigation: the URL still points at the workspace root and the
  // session list for this cwd is empty.
  await expect(page).toHaveURL(new RegExp(`/workspace/${encodeURIComponent(VISUAL_LANDING_CWD).replace(/\//g, "\\/")}$`));
  await screenshot(page, "workspace-landing.png");
});

test("collapsed context panel leaves a stable expand control", async ({ page }, testInfo) => {
  // The mobile project starts with the context panel closed and has its own
  // drawer coverage in sidebar.spec.ts, so this baseline only covers desktop.
  test.skip(testInfo.project.name === "mobile", "mobile starts with the context panel closed");
  await page.goto(workspaceRoute(VISUAL_CWD));
  // The workspace root auto-navigates into the most recent session; wait for
  // the settled thread so the shell screenshot is not racing the message load.
  await waitForConversationSettled(page);
  const toggle = page.getByRole("button", { name: /^(Expand|Collapse) sidebar$/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#workspace-context-panel")).toHaveAttribute("hidden");
  await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toBeVisible();
  await expect(page.locator('nav[aria-label="Primary navigation"]')).toBeHidden();
  await screenshot(page, "sidebar-collapsed.png");
});
