/** Browser acceptance for the unified composer completion (PRD
 *  docs/prd-pr114-main-adaptation.md §7 AC-01, AC-05, AC-07, AC-10, AC-22,
 *  AC-23, AC-24 and §8.5).
 *
 *  The fixture server answers the endpoints the other visual specs need, so
 *  this spec re-routes the four the completion layer reads (command catalogue,
 *  subagent discovery, per-directory listings, breadcrumbs) and counts prompt
 *  POSTs. Accepting a candidate must only edit the input, so the counter has to
 *  stay at zero for the whole file, the accessibility test included.
 *
 *  No baseline: every assertion here is DOM text or geometry, so the matrix
 *  runs without adding screenshots.
 */

import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, test, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD, VISUAL_SESSION } from "./fixtures/data.mjs";

const SESSION_ROUTE = workspaceRoute(VISUAL_CWD, `/session/${VISUAL_SESSION}`);

/** Longer than the menu's 55%-wide label box at every project width, so the
 *  truncation assertion below measures the label instead of the viewport. */
const LONG_NAME = "spectrophotometer-calibration-absorbance-timeseries-2026-08-15-raw.csv";

/** The catalogue the control plane serves for a session: one discovered skill
 *  and one prompt-template command. `summarize` is the command AC-01 accepts. */
const COMMANDS = {
  commands: [
    { name: "skill:review", description: "Review files", source: "skill", group: "skill" },
    { name: "summarize", description: "Summarize text", source: "prompt", group: "utility" },
  ],
};

const AGENTS = {
  agents: [
    { name: "reviewer", description: "Review work", source: "builtin" },
    { name: "scout", description: "Gather context", source: "builtin" },
  ],
};

/** One array per directory, keyed by the `subdir` the composer asked for: the
 *  listing of that directory, never one flattened workspace tree. */
const LISTINGS: Record<string, Array<{ path: string; name: string; isDir: boolean; size: number; modified: number }>> = {
  "": [
    { path: "README.md", name: "README.md", isDir: false, size: 512, modified: 0 },
    { path: "review-notes.md", name: "review-notes.md", isDir: false, size: 320, modified: 0 },
    { path: "analysis", name: "analysis", isDir: true, size: 0, modified: 0 },
    { path: "data", name: "data", isDir: true, size: 0, modified: 0 },
  ],
  analysis: [{ path: "analysis/report.md", name: "report.md", isDir: false, size: 2048, modified: 0 }],
  data: [
    { path: "data/protein.csv", name: "protein.csv", isDir: false, size: 4096, modified: 0 },
    { path: `data/${LONG_NAME}`, name: LONG_NAME, isDir: false, size: 8192, modified: 0 },
  ],
};

/** Every prompt POST the page made. A completion that sends adds an entry. */
const promptRequests: string[] = [];

async function mockCompletionApis(page: Page): Promise<void> {
  await page.route((url) => url.pathname.endsWith("/prompt"), (route) => {
    promptRequests.push(`${route.request().method()} ${route.request().url()}`);
    return route.fulfill({ json: { ok: true } });
  });
  await page.route((url) => url.pathname.endsWith("/commands"), (route) => route.fulfill({ json: COMMANDS }));
  await page.route((url) => url.pathname === "/api/settings/subagents/discovery", (route) => route.fulfill({ json: AGENTS }));
  await page.route((url) => url.pathname.startsWith("/api/files"), (route) => {
    const { pathname, searchParams } = new URL(route.request().url());
    if (pathname === "/api/files") return route.fulfill({ json: LISTINGS[searchParams.get("subdir") ?? ""] ?? [] });
    if (pathname === "/api/files/breadcrumbs") {
      const segments = (searchParams.get("subdir") ?? "").split("/").filter(Boolean);
      return route.fulfill({ json: segments.map((name, index) => ({ name, path: segments.slice(0, index + 1).join("/") })) });
    }
    // File contents still come from the fixture server.
    return route.fallback();
  });
}

/** The transcript header proves the fixture session is loaded and active, which is what the
 *  command catalogue query needs. The composer's own readiness is the editable message input;
 *  nothing here depends on how the thread renders tool results. */
async function openComposer(page: Page): Promise<Locator> {
  await page.goto(SESSION_ROUTE);
  await expect(page.getByRole("heading", { name: "Shikimate pathway analysis" })).toBeVisible();
  const composer = page.getByRole("combobox", { name: "Message" });
  await expect(composer).toBeVisible();
  await expect(composer).toBeEditable();
  return composer;
}

const horizontalOverflow = (page: Page) => page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
}));

test.beforeEach(async ({ page }) => {
  promptRequests.length = 0;
  await mockCompletionApis(page);
});

test.afterEach(() => {
  expect(promptRequests, "a completion key sent a prompt").toEqual([]);
});

test("AC-01 /sum then Tab leaves /summarize in the composer and sends nothing", async ({ page }) => {
  const composer = await openComposer(page);
  await composer.fill("/sum");

  const menu = page.getByRole("listbox");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option")).toHaveCount(1);
  await expect(menu.getByRole("option")).toContainText("/summarize");

  await composer.press("Tab");
  await expect(composer).toHaveValue("/summarize");
  await expect(menu).toHaveCount(0);
});

test("AC-05 /export then Tab, ArrowDown, Enter accepts jsonl and leaves the session untouched", async ({ page }) => {
  const composer = await openComposer(page);
  await composer.fill("/export");
  await composer.press("Space");
  await expect(composer).toHaveValue("/export ");

  const menu = page.getByRole("listbox");
  // An argument nobody type-checked yet keeps the list shut: Enter would send.
  await expect(menu).toHaveCount(0);

  await composer.press("Tab");
  await expect(menu).toBeVisible();
  const rows = menu.getByRole("option");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("html");
  await expect(rows.nth(1)).toContainText("jsonl");
  await expect(composer).toHaveAttribute("aria-activedescendant", /-option-0$/);

  await composer.press("ArrowDown");
  await expect(composer).toHaveAttribute("aria-activedescendant", /-option-1$/);
  await composer.press("Enter");
  await expect(composer).toHaveValue("/export jsonl");
  await expect(menu).toHaveCount(0);
});

test("AC-07 data/pro then Tab fills the workspace path data/protein.csv", async ({ page }) => {
  const composer = await openComposer(page);
  await composer.fill("data/pro");

  const menu = page.getByRole("listbox");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option")).toHaveCount(1);
  await expect(menu.getByRole("option")).toContainText("protein.csv");

  await composer.press("Tab");
  await expect(composer).toHaveValue("data/protein.csv");
  await expect(menu).toHaveCount(0);
});

test("AC-10 @rev then hovering the reviewer row and Tab builds the subagent chip", async ({ page }) => {
  const composer = await openComposer(page);
  await composer.fill("@rev");

  const menu = page.getByRole("listbox", { name: "Completions" });
  await expect(menu).toBeVisible();
  const rows = menu.getByRole("option");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("@reviewer");
  await expect(rows.nth(1)).toContainText("review-notes.md");

  // Move the selection off the reviewer row first: the hover below has to put it back, so Tab
  // accepting the reviewer proves the row under the pointer became the current row.
  await composer.press("ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");

  const reviewer = rows.filter({ hasText: "@reviewer" });
  await reviewer.hover();
  await expect(reviewer).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "false");

  await composer.press("Tab");
  await expect(composer).toHaveValue("@reviewer ");
  await expect(menu).toHaveCount(0);

  // The mention is a highlighted chip, not plain text: the composer renders it in its overlay.
  const chip = page.locator('div[aria-hidden="true"].whitespace-pre-wrap span');
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText("@reviewer");
  expect(await chip.evaluate((element) => getComputedStyle(element).backgroundColor), "mention chip background").not.toBe("rgba(0, 0, 0, 0)");
});

test("AC-22 a key pressed on a settings control is not consumed by completion", async ({ page }) => {
  const composer = await openComposer(page);
  await composer.fill("/sum");
  await expect(page.getByRole("listbox")).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  // The list belongs to the composer and left with the focus; the draft is still a completion token.
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(composer).toHaveValue("/sum");

  const general = dialog.getByRole("tab", { name: "General" });
  await general.click();
  await expect(general).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Tab");
  const movedTo = await page.evaluate(() => document.activeElement?.id ?? "");
  expect(movedTo, "Tab must move focus between the settings controls").toMatch(/^settings-tab-.+/);
  expect(movedTo).not.toBe("settings-tab-general");

  // Enter belongs to the focused settings tab: it activates that tab and never the composer.
  await page.keyboard.press("Enter");
  await expect(dialog.locator(`#${movedTo}`)).toHaveAttribute("aria-selected", "true");

  await expect(composer).toHaveValue("/sum");
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("AC-23 an open menu with a long candidate keeps 375px layouts free of horizontal overflow", async ({ page }, testInfo) => {
  const composer = await openComposer(page);
  await composer.fill("data/");

  const menu = page.getByRole("listbox");
  await expect(menu).toBeVisible();
  const pageWidth = await horizontalOverflow(page);
  expect(pageWidth.scrollWidth, `page horizontal overflow ${pageWidth.scrollWidth} > ${pageWidth.innerWidth}`).toBeLessThanOrEqual(pageWidth.innerWidth);
  const menuWidth = await menu.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  expect(menuWidth.scrollWidth, "the candidate list must not scroll sideways").toBeLessThanOrEqual(menuWidth.clientWidth + 1);

  const longRow = menu.getByRole("option").filter({ hasText: LONG_NAME });
  await expect(longRow).toHaveCount(1);
  const label = longRow.locator(`span[title="${LONG_NAME}"]`);
  await expect(label).toHaveCount(1);

  // The current row stays inside the viewport even though its label is clipped, and the clipped
  // text is still readable through the title attribute.
  await longRow.hover();
  await expect(longRow).toHaveAttribute("aria-selected", "true");
  const box = await longRow.boundingBox();
  expect(box, "the selected row has no box").not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(pageWidth.innerWidth);

  if (testInfo.project.name === "mobile") {
    expect(pageWidth.innerWidth).toBeLessThanOrEqual(375);
    const labelWidth = await label.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
    expect(labelWidth.clientWidth, "the long label has no box to truncate into").toBeGreaterThan(0);
    expect(labelWidth.scrollWidth, "the long label was not clipped").toBeGreaterThan(labelWidth.clientWidth);
  }
});

test("AC-24 the open completion menu has no serious axe violations @accessibility", async ({ page }) => {
  const composer = await openComposer(page);
  await composer.fill("/sum");
  await expect(page.getByRole("listbox")).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious");
  expect(
    serious,
    `unexpected critical/serious axe violations with the completion menu open:\n`
    + serious.map((violation) => `- ${violation.id}: ${violation.help} (${violation.nodes.length} node(s))`).join("\n"),
  ).toEqual([]);
});
