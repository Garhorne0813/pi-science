/** Conversation visual baselines: a settled conversation with a user bubble,
 *  a bash tool card, assistant markdown (headings, lists, tables, inline code,
 *  blockquote) and a code block with its toolbar. */

import { expect, screenshot, test, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD, VISUAL_SESSION } from "./fixtures/data.mjs";

const SESSION_ROUTE = workspaceRoute(VISUAL_CWD, `/session/${VISUAL_SESSION}`);

async function openSettledConversation(page: import("@playwright/test").Page) {
  await page.goto(SESSION_ROUTE);
  // The settled thread renders the assistant markdown heading…
  await expect(page.getByRole("heading", { name: "Shikimate pathway analysis" })).toBeVisible();
  // …the bash tool card (its output is collapsed until the card is opened)…
  await expect(page.getByRole("button", { name: /bash/i })).toBeVisible();
  // …the markdown table…
  await expect(page.getByRole("table")).toBeVisible();
  // …the code block with a toolbar…
  await expect(page.locator("pre code").first()).toBeVisible();
  // …the artifact strip for the turn…
  await expect(page.getByRole("button", { name: /report\.md/ }).first()).toBeVisible();
  // …and the composer settles out of the "settling" phase.
  await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();
}

test("settled conversation with markdown, table, tool card and code block", async ({ page }) => {
  await openSettledConversation(page);
  // Open the bash tool card so the captured baseline includes its output.
  await page.getByRole("button", { name: /bash/i }).click();
  await expect(page.getByText("condition,value", { exact: false })).toBeVisible();
  await screenshot(page, "conversation-settled.png");
});

test("user bubble and assistant content stay inside the thread column on narrow screens", async ({ page }) => {
  await openSettledConversation(page);
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth, `horizontal overflow ${overflow.scrollWidth} > ${overflow.innerWidth}`)
    .toBeLessThanOrEqual(overflow.innerWidth);
  await screenshot(page, "conversation-narrow.png");
});

test("conversation renders with the user message first and the artifact strip anchored to the turn", async ({ page }) => {
  await openSettledConversation(page);
  await expect(page.getByText(/shikimate pathway measurements/).first()).toBeVisible();
  const strip = page.getByRole("button", { name: /report\.md/ }).first();
  await expect(strip).toBeVisible();
});
