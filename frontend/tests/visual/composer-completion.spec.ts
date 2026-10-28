/** Browser acceptance for the unified composer completion (PRD
 *  docs/archive/prd-pr114-main-adaptation.md §7 AC-01, AC-05, AC-07, AC-10, AC-22,
 *  AC-23, AC-24 and §8.5).
 *
 *  The fixture server answers the endpoints the other visual specs need, so
 *  this spec re-routes the four the completion layer reads (command catalogue,
 *  subagent discovery, per-directory listings, breadcrumbs) and counts prompt
 *  POSTs. Accepting a candidate must only edit the input, so the counter has to
 *  stay at zero for the whole file, the accessibility test included.
 *
 *  This file also carries the browser acceptance for the inline structured
 *  references (PRD docs/archive/prd-composer-inline-structured-references.md §7.1 and
 *  §8C): a real keyboard undo/redo, and edits that reach the composer without
 *  an input transaction.
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

const inlineToken = (page: Page) => page.locator('div[aria-hidden="true"].whitespace-pre-wrap span');

/** Types the bare token, walks into the data folder and accepts protein.csv. The completion places
 *  the caret in the same commit as the text, so the caret is already one position past the token. */
async function acceptProteinReference(page: Page, composer: Locator): Promise<void> {
  await composer.fill("@");
  const menu = page.getByRole("listbox");
  await expect(menu).toBeVisible();
  await menu.getByRole("option", { name: /data.*Open folder/ }).click();
  await menu.getByRole("option", { name: /protein\.csv/ }).click();
  await expect(composer).toHaveValue("@data/protein.csv ");
  expect(await composer.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(18);
}

const caretAt = (composer: Locator) => composer.evaluate((element: HTMLTextAreaElement) => element.selectionStart);

/** The picked file is compared end to end: the token stays in the sentence with
 *  its identity, the old top-bar card must not come back, and the browser's own
 *  undo and redo move the text and the identity together. */
test.describe("inline structured references", () => {
  test("browsing keeps the token inline and Cmd/Ctrl undo restores text and identity together", async ({ page }, testInfo) => {
    // Keyboard chords are worth one real browser; the DOM contract is identical in the other projects.
    test.skip(testInfo.project.name !== "desktop-light", "one real browser is enough for the keyboard contract");
    const composer = await openComposer(page);
    await composer.fill("@");

    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    const folderRow = menu.getByRole("option", { name: /data.*Open folder/ });
    await expect(folderRow).toHaveCount(1);
    await folderRow.click();

    // Browsing moves the menu into the folder and leaves the sentence untouched.
    await expect(composer).toHaveValue("@");
    const breadcrumbs = page.getByRole("navigation", { name: "Workspace folder path" });
    await expect(breadcrumbs.getByRole("button", { name: "data" })).toBeVisible();
    const fileRow = menu.getByRole("option", { name: /protein\.csv/ });
    await expect(fileRow).toHaveCount(1);
    await fileRow.click();

    await expect(composer).toHaveValue("@data/protein.csv ");
    await expect(inlineToken(page)).toHaveCount(1);
    await expect(inlineToken(page)).toHaveText("@data/protein.csv");
    await expect(page.getByRole("button", { name: "Remove reference protein.csv" })).toHaveCount(0);

    await composer.press("ControlOrMeta+z");
    await expect(composer).toHaveValue("@");
    await expect(inlineToken(page)).toHaveCount(0);

    await composer.press("ControlOrMeta+Shift+z");
    await expect(composer).toHaveValue("@data/protein.csv ");
    await expect(inlineToken(page)).toHaveText("@data/protein.csv");
  });

  test("an edit with no input transaction keeps the untouched binding and cut removes it", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-light", "one real browser is enough for the keyboard contract");
    const composer = await openComposer(page);
    await composer.fill("@");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.getByRole("listbox").getByRole("option", { name: /data.*Open folder/ }).click();
    await page.getByRole("listbox").getByRole("option", { name: /protein\.csv/ }).click();
    await expect(composer).toHaveValue("@data/protein.csv ");

    // An edit that never announced itself: the text changes and no beforeinput precedes it. The
    // binding the edit did not touch has to survive, and the token has to move with its text.
    await composer.evaluate((element: HTMLTextAreaElement) => {
      const value = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      value?.set?.call(element, `prefix ${element.value}`);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(composer).toHaveValue("prefix @data/protein.csv ");
    await expect(inlineToken(page)).toHaveCount(1);
    await expect(inlineToken(page)).toHaveText("@data/protein.csv");

    await composer.press("Home");
    await composer.press("Shift+End");
    await composer.press("ControlOrMeta+x");
    await expect(composer).toHaveValue("");
    await expect(inlineToken(page)).toHaveCount(0);
  });

  test("a completion inside a sentence places the caret on the token before the next key", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-light", "one real browser is enough for the caret contract");
    const composer = await openComposer(page);
    await composer.pressSequentially("before @ after");
    await composer.press("Home");
    for (let step = 0; step < 8; step += 1) await composer.press("ArrowRight");
    expect(await caretAt(composer), "the caret sits right after the bare @").toBe(8);

    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    await menu.getByRole("option", { name: /data.*Open folder/ }).click();
    await menu.getByRole("option", { name: /protein\.csv/ }).click();

    await expect(composer).toHaveValue("before @data/protein.csv after");
    // No frame is awaited: the caret already belongs to the token instead of the end of the sentence.
    expect(await caretAt(composer)).toBe(24);
    await composer.press("ArrowLeft");
    expect(await caretAt(composer), "the next key starts from the token, not the end of the text").toBe(7);
  });

  test("an arrow key crosses a bound reference at its boundary", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-light", "one real browser is enough for the keyboard contract");
    const composer = await openComposer(page);
    await acceptProteinReference(page, composer);

    await composer.press("ArrowLeft");
    expect(await caretAt(composer), "one step left lands on the token end").toBe(17);
    await composer.press("ArrowLeft");
    expect(await caretAt(composer), "the next step crosses the whole token").toBe(0);
    await expect(inlineToken(page)).toHaveText("@data/protein.csv");

    await composer.press("ArrowRight");
    expect(await caretAt(composer), "one step right crosses the whole token back").toBe(17);
  });

  test("a shifted arrow selects the whole reference and keeps its direction", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-light", "one real browser is enough for the keyboard contract");
    const composer = await openComposer(page);
    await acceptProteinReference(page, composer);

    await composer.press("ArrowLeft");
    await composer.press("Shift+ArrowLeft");
    const selection = await composer.evaluate((element: HTMLTextAreaElement) => ({
      start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection,
    }));
    expect(selection).toEqual({ start: 0, end: 17, direction: "backward" });
  });

  test("clicking inside a bound reference lands on the nearer end", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-light", "one real browser is enough for the pointer contract");
    const composer = await openComposer(page);
    await acceptProteinReference(page, composer);
    const box = await inlineToken(page).boundingBox();
    expect(box, "the highlighted token has no box").not.toBeNull();

    await page.mouse.click(box!.x + 3, box!.y + box!.height / 2);
    expect(await caretAt(composer), "the left half snaps to the token start").toBe(0);
    await page.mouse.click(box!.x + box!.width - 3, box!.y + box!.height / 2);
    expect(await caretAt(composer), "the right half snaps to the token end").toBe(17);
  });

  test("a word-wise arrow is not trapped by a bound reference", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-light", "one real browser is enough for the keyboard contract");
    const composer = await openComposer(page);
    await acceptProteinReference(page, composer);
    await composer.press("Home");
    await composer.pressSequentially("before ");
    await expect(composer).toHaveValue("before @data/protein.csv ");
    await composer.press("End");
    expect(await caretAt(composer), "End leaves the caret at the end of the line").toBe(25);

    // "before " shifted the token to [7, 24), so 24 is its right boundary.
    await composer.press("ArrowLeft");
    expect(await caretAt(composer), "plain left lands on the right boundary").toBe(24);

    // macOS moves by word on Option and binds Ctrl+ArrowLeft to the line start, which already
    // leaves the token. Windows and Linux move by word on Ctrl.
    const wordLeft = process.platform === "darwin" ? "Alt+ArrowLeft" : "Control+ArrowLeft";
    const wordRight = process.platform === "darwin" ? "Alt+ArrowRight" : "Control+ArrowRight";
    await composer.press(wordLeft);
    expect(await caretAt(composer), "the word key crosses to the left boundary").toBe(7);
    await composer.press(wordLeft);
    expect(await caretAt(composer), "the next press continues into the preceding word").toBe(0);

    for (let step = 0; step < 7; step += 1) await composer.press("ArrowRight");
    expect(await caretAt(composer), "the caret is back on the left boundary").toBe(7);
    await composer.press(wordRight);
    expect(await caretAt(composer), "the word key crosses to the right boundary").toBe(24);
    await composer.press(wordRight);
    expect(await caretAt(composer), "the next press continues past the reference").toBe(25);

    if (process.platform === "darwin") {
      await composer.press("ArrowLeft");
      expect(await caretAt(composer)).toBe(24);
      await composer.press("Control+ArrowLeft");
      expect(await caretAt(composer), "the line-start chord leaves the token as well").toBe(0);
    }
    await expect(inlineToken(page)).toHaveText("@data/protein.csv");
  });

  test("a real CJK composition keeps the binding and the history moves it with the text", async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-light", "one real browser is enough for the keyboard contract");
    const composer = await openComposer(page);
    await acceptProteinReference(page, composer);
    await page.evaluate(() => {
      (window as unknown as { ime: string[] }).ime = [];
      const record = (name: string) => (event: Event) => {
        (window as unknown as { ime: string[] }).ime.push(`${name}:${(event as InputEvent).inputType ?? ""}`);
      };
      document.addEventListener("beforeinput", record("beforeinput"), true);
      document.addEventListener("compositionend", record("compositionend"), true);
    });

    const cdp = await context.newCDPSession(page);
    await composer.press("Home");
    await cdp.send("Input.imeSetComposition", { text: "pin", selectionStart: 3, selectionEnd: 3 });
    await cdp.send("Input.insertText", { text: "拼音 " });

    await expect(composer).toHaveValue("拼音 @data/protein.csv ");
    await expect(inlineToken(page)).toHaveText("@data/protein.csv");
    const events = await page.evaluate(() => (window as unknown as { ime: string[] }).ime);
    expect(events).toContain("beforeinput:insertCompositionText");
    expect(events).toContain("compositionend:");

    // A composition commits in more than one step, so undo walks back one step at a time. The
    // binding has to survive every step, not just the last one.
    for (let attempt = 0; attempt < 3 && await composer.inputValue() !== "@data/protein.csv "; attempt += 1) {
      await composer.press("ControlOrMeta+z");
      await expect(inlineToken(page)).toHaveText("@data/protein.csv");
    }
    await expect(composer).toHaveValue("@data/protein.csv ");
  });
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
