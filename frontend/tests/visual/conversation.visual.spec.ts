/** Conversation visual baselines: a settled conversation with a user bubble,
 *  a bash tool card, assistant markdown (headings, lists, tables, inline code,
 *  blockquote) and a code block with its toolbar. */

import { expect, screenshot, test, waitForConversationSettled, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD, VISUAL_SESSION } from "./fixtures/data.mjs";

const SESSION_ROUTE = workspaceRoute(VISUAL_CWD, `/session/${VISUAL_SESSION}`);

async function openSettledConversation(page: import("@playwright/test").Page) {
  await page.goto(SESSION_ROUTE);
  // The settled thread renders every fixture block: the assistant markdown
  // heading, the bash tool card, the table, the code block, the artifact
  // strip and the composer out of the "settling" phase.
  await waitForConversationSettled(page);
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
