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

test("running composer keeps the queue send and stop controls inside the card", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "phone and tablet widths are checked once");
  // The run this test starts never settles on the mock stream, so the composer
  // stays in its running layout: queue send and stop, no prompt send.
  await page.route("**/api/sessions/*/queue*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ queue: { session_id: VISUAL_SESSION, paused: false, entries: [], updated_at: new Date().toISOString() } }) }));
  await openSettledConversation(page);
  await page.getByRole("combobox", { name: "Message", exact: true }).fill("Add the fold change for the control arm.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop generation" })).toBeVisible();

  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layout = await page.evaluate(() => {
      const rect = (element: Element | null | undefined) => {
        if (!element) throw new Error("composer control missing while running");
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width };
      };
      const byLabel = (label: string) => [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === label);
      const stopButton = byLabel("Stop generation");
      const cluster = stopButton?.parentElement;
      const card = document.querySelector('[role="combobox"][aria-label="Message"]')?.closest(".ui-card");
      if (!cluster || !card) throw new Error("composer control row missing while running");
      return {
        card: rect(card),
        queueSend: rect(byLabel("Add to the follow-up queue")),
        stop: rect(stopButton),
        clusterClientWidth: cluster.clientWidth,
        clusterScrollWidth: cluster.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    expect(layout.clusterScrollWidth, `control row overflows the card at ${width}px`).toBeLessThanOrEqual(layout.clusterClientWidth);
    for (const [name, box] of [["queue send", layout.queueSend], ["stop", layout.stop]] as const) {
      expect(box.left, `${name} starts inside the card at ${width}px`).toBeGreaterThanOrEqual(layout.card.left);
      expect(box.right, `${name} ends inside the card at ${width}px`).toBeLessThanOrEqual(layout.card.right);
      expect(box.right, `${name} ends inside the viewport at ${width}px`).toBeLessThanOrEqual(layout.viewportWidth);
    }
  }
});
