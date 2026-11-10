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
  // The activity surface aggregates the turn's tool events behind one summary,
  // so expanding the summary is what reveals the bash tool row; opening the row
  // then shows its output in the baseline.
  await page.getByRole("button", { name: /^Completed · 1m00s\. Total turn duration: 1m00s$/ }).click();
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

test("running composer keeps the send mode, send and stop inside the card", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "phone and tablet widths are checked once");
  // The client started, and the thread renders, but the run never settles, so
  // the composer stays in its running state for the geometry assertions.
  await page.route("**/api/sessions/*/state*", async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...state, is_streaming: true }) });
  });
  await page.route("**/api/sessions/*/queue*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session_id: VISUAL_SESSION, paused: false, entries: [], updated_at: new Date().toISOString() }) }));
  await openSettledConversation(page);
  await page.getByPlaceholder(/Ask anything/).fill("Add the fold change for the control arm.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Stop generation" })).toBeVisible();

  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layout = await page.evaluate(() => {
      const rect = (element: Element | null | undefined) => {
        if (!element) throw new Error("composer control missing while running");
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width };
      };
      const stopButton = [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Stop generation");
      const row = document.querySelector('[role="group"][aria-label="Send while running as"]')?.parentElement?.parentElement;
      if (!row) throw new Error("composer control row missing while running");
      return {
        card: rect(document.querySelector(".ui-card")),
        stop: rect(stopButton),
        rowClientWidth: row.clientWidth,
        rowScrollWidth: row.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    expect(layout.rowScrollWidth, `control row overflows the card at ${width}px`).toBeLessThanOrEqual(layout.rowClientWidth);
    expect(layout.stop.left, `stop button starts inside the card at ${width}px`).toBeGreaterThanOrEqual(layout.card.left);
    expect(layout.stop.right, `stop button ends inside the card at ${width}px`).toBeLessThanOrEqual(layout.card.right);
    expect(layout.stop.right, `stop button ends inside the viewport at ${width}px`).toBeLessThanOrEqual(layout.viewportWidth);
  }
});
