/** App-shell visual baselines: projects page, workspace landing and the
 *  collapsible sidebar across the fixed viewport matrix. */

import { expect, screenshot, test, waitForConversationSettled, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD, VISUAL_LANDING_CWD } from "./fixtures/data.mjs";

test("projects page renders workspace cards", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Visual Demo", { exact: true })).toBeVisible();
  await expect(page.getByText("Shikimate Project", { exact: true })).toBeVisible();
  await screenshot(page, "projects.png");
});

test("workspace landing shows the hero composer", async ({ page }) => {
  // Dedicated session-free cwd: the mock server returns an empty session
  // list here, so nothing can redirect the workspace route into a session
  // and the page must render the true landing hero.
  await page.goto(workspaceRoute(VISUAL_LANDING_CWD));
  // Real landing hero: welcome copy plus the centered composer.
  await expect(page.getByRole("heading", { name: "Pi-Science" })).toBeVisible();
  await expect(page.getByText("Scientific AI Workbench", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();
  // No auto-navigation: the URL still points at the workspace root and the
  // session list for this cwd is empty.
  await expect(page).toHaveURL(new RegExp(`/workspace/${encodeURIComponent(VISUAL_LANDING_CWD).replace(/\//g, "\\/")}$`));
  await screenshot(page, "workspace-landing.png");
});

test("collapsed context panel leaves a stable primary rail", async ({ page }, testInfo) => {
  // The mobile project starts with the context panel closed and has its own
  // drawer coverage in sidebar.spec.ts, so this baseline only covers desktop.
  test.skip(testInfo.project.name === "mobile", "mobile starts with the context panel closed");
  await page.goto(workspaceRoute(VISUAL_CWD));
  // The workspace root auto-navigates into the most recent session; wait for
  // the settled thread so the rail screenshot is not racing the message load.
  await waitForConversationSettled(page);
  const toggle = page.getByRole("button", { name: "Workspace context panel" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#workspace-context-panel")).toHaveAttribute("hidden");
  // The Rail is permanent: collapsing the panel must not take navigation away.
  await expect(page.locator('nav[aria-label="Primary navigation"]').getByRole("link", { name: "Conversations", exact: true })).toBeVisible();
  await screenshot(page, "sidebar-collapsed.png");
});
