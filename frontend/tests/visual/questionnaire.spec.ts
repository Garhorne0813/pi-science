/** Compact question mode geometry and draft lifecycle in the production app. */
import type { Page } from "@playwright/test";
import { test, expect, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD, VISUAL_SESSION } from "./fixtures/data.mjs";

type PreviewWindow = Window & { questionSources: EventSource[] };
const callId = "compact-question-tool";
const requestId = "compact-question-request";
const questions = [
  { question: "Which analysis should we run next?", header: "Analysis", multiSelect: false, options: [
    { label: "Differential expression (Recommended)", description: "Compare treatment and control before pathway enrichment.", preview: "### Analysis plan\n" + "\n- Normalize expression and compare treatment groups.\n".repeat(30) },
    { label: "Metabolic network modelling", description: "Explore flux changes in the reaction network." },
    { label: "Review data quality first", description: "Inspect missing values and batch effects." },
  ] },
  { question: "Which outputs do you need?", header: "Outputs", multiSelect: true, options: [{ label: "Figures", description: "Publication-ready plots." }, { label: "Tables", description: "Reusable result tables." }] },
];
async function emit(page: Page, events: Array<Record<string, unknown>>) {
  await page.evaluate(({ events, session }) => {
    const source = (window as unknown as PreviewWindow).questionSources.find((item) => item.url.includes(`/sessions/${session}/events`));
    if (!source) throw new Error("Session event stream missing");
    for (const event of events) source.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ sessionId: session, ...event }) }));
  }, { events, session: VISUAL_SESSION });
}
async function openQuestion(page: Page, questionData = questions) {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    (window as unknown as PreviewWindow).questionSources = [];
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) { super(url, options); (window as unknown as PreviewWindow).questionSources.push(this); }
    };
  });
  await page.goto(workspaceRoute(VISUAL_CWD, `/session/${VISUAL_SESSION}`));
  await expect(page.getByRole("heading", { name: "Shikimate pathway analysis" })).toBeVisible();
  await page.getByRole("combobox", { name: "Message", exact: true }).fill("Keep my unsent research question");
  await emit(page, [{ type: "questionnaire.asked", toolCallId: callId, questions: questionData }, { type: "interaction.requested", requestId, toolCallId: callId, questionnaire: true, method: "input", title: "Analysis" }]);
  await expect(page.getByRole("region", { name: "Answer a few questions" })).toBeVisible();
}

test("question mode stays compact, details do not resize it, and collapse preserves drafts", async ({ page }, testInfo) => {
  await openQuestion(page);
  const form = page.getByRole("region", { name: "Answer a few questions" });
  const input = page.getByRole("combobox", { name: "Message", exact: true, includeHidden: true });
  await expect(input).toBeHidden();
  const first = await form.boundingBox();
  expect(first).not.toBeNull();
  if (page.viewportSize()!.width >= 1024) expect(first!.height).toBeLessThanOrEqual(280);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("radio", { name: /Differential expression/ }).click();
  await expect(page.getByRole("heading", { name: questions[0]!.question })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("question-compact.png") });
  await page.getByRole("button", { name: /Preview Differential expression/ }).click();
  const details = page.getByRole("dialog", { name: /Preview Differential expression/ });
  await expect(details).toBeVisible();
  const preview = await details.boundingBox();
  const viewport = page.viewportSize()!;
  expect(preview!.x).toBeGreaterThanOrEqual(0);
  expect(preview!.x + preview!.width).toBeLessThanOrEqual(viewport.width);
  expect(preview!.y).toBeGreaterThanOrEqual(0);
  expect(preview!.y + preview!.height).toBeLessThanOrEqual(viewport.height);
  expect((await form.boundingBox())!.height).toBe(first!.height);
  await page.screenshot({ path: testInfo.outputPath("question-details.png") });
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await expect(page.getByRole("button", { name: /Preview Differential expression/ })).toBeFocused();
  await expect(form).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(form).toBeHidden();
  await expect(page.getByRole("button", { name: /Continue answering/ })).toContainText("1 of 2 answered");
  await expect(input).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("question-collapsed.png") });
  await page.getByRole("button", { name: /Continue answering/ }).click();
  await expect(page.getByRole("radio", { name: /Differential expression/ })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await emit(page, [{ type: "questionnaire.finished", toolCallId: callId }]);
  await expect(input).toBeVisible();
  await expect(input).toHaveText("Keep my unsent research question");
  await expect(input).toBeFocused();
});

test("long question content scrolls above visible actions in a short viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 768, height: 480 });
  await openQuestion(page);
  await page.getByRole("button", { name: /Type something/ }).click();
  await page.getByRole("textbox", { name: "Your answer" }).fill("A custom analysis with a longer explanation");
  await page.getByRole("button", { name: "Notes for this question" }).click();
  const form = page.getByRole("region", { name: "Answer a few questions" });
  const box = await form.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(240);
  expect(box!.y).toBeGreaterThanOrEqual(44);
  expect(box!.y + box!.height).toBeLessThanOrEqual(480);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("checkbox", { name: "Tables", exact: true }).click();
  await expect(page.getByRole("button", { name: "Submit answers" })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("question-short-viewport.png") });
});

test("review regressions preserve saved choices and respect the user's focus", async ({ page }) => {
  await openQuestion(page);
  const heading = page.getByRole("heading", { name: questions[0]!.question });
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole("radio", { name: /Differential expression/ }).focus();
    await page.keyboard.press("Control+Enter");
    await expect(page.getByRole("alert")).toContainText("Please answer question 1");
    await expect(heading).toBeFocused();
  }
  await page.getByRole("radio", { name: /Differential expression/ }).click();
  await page.getByRole("button", { name: /Type something/ }).click();
  await page.getByRole("textbox", { name: "Your answer" }).fill("   ");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("checkbox", { name: "Tables", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("radio", { name: /Differential expression/ })).toBeChecked();
  // Model an independently focused inspector editor, outside the question seat.
  await page.evaluate(() => {
    const editor = document.createElement("textarea");
    editor.setAttribute("aria-label", "Independent file editor");
    document.body.append(editor);
    editor.focus();
  });
  const other = page.getByRole("textbox", { name: "Independent file editor" });
  await expect(other).toBeFocused();
  await emit(page, [{ type: "questionnaire.finished", toolCallId: callId }]);
  await expect(page.getByRole("region", { name: "Answer a few questions" })).toHaveCount(0);
  await expect(other).toBeFocused();
  const composer = page.getByRole("combobox", { name: "Message", exact: true });
  await expect(composer).toBeVisible();
  await expect(composer).toHaveText("Keep my unsent research question");
});


test("radio keyboard selection uses a single Tab stop and leaves custom and checkboxes independent", async ({ page }) => {
  // No detail actions here: isolate the radio group's own Tab entry/exit.
  await openQuestion(page, questions.map((question) => ({ ...question, options: question.options.map((option) => ({ label: option.label, description: "" })) })));
  const radios = page.getByRole("radio");
  const collapse = page.getByRole("button", { name: "Collapse", exact: true });
  const custom = page.getByRole("button", { name: /Type something/ });
  await collapse.focus();
  await page.keyboard.press("Tab");
  await expect(radios.nth(0)).toBeFocused();
  await expect(radios.nth(0)).not.toBeChecked();
  await page.keyboard.press("Tab");
  await expect(custom).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(radios.nth(0)).toBeFocused();
  for (const [key, index] of [["ArrowRight", 1], ["ArrowDown", 2], ["ArrowDown", 0], ["ArrowUp", 2], ["ArrowLeft", 1]] as const) {
    await page.keyboard.press(key);
    await expect(radios.nth(index)).toBeFocused();
    await expect(radios.nth(index)).toBeChecked();
    expect(await radios.evaluateAll((items) => items.filter((item) => (item as HTMLElement).tabIndex === 0).length)).toBe(1);
  }
  await radios.nth(2).click();
  await collapse.focus();
  await page.keyboard.press("Tab");
  await expect(radios.nth(2)).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(collapse).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(custom).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(custom).toBeFocused();
  await expect(radios.nth(2)).toBeChecked();
  await page.keyboard.press("Space");
  await page.getByRole("textbox", { name: "Your answer" }).fill("Custom analysis");
  await page.getByRole("button", { name: "Save answer" }).click();
  await collapse.focus();
  await page.keyboard.press("Tab");
  await expect(radios.nth(0)).toBeFocused();
  await expect(radios.nth(0)).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(radios.nth(0)).toBeChecked();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const boxes = page.getByRole("checkbox");
  await boxes.nth(0).focus();
  await page.keyboard.press("Tab");
  await expect(boxes.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(boxes.nth(0)).toBeFocused();
  await expect(boxes.nth(0)).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(boxes.nth(0)).toBeChecked();
  await page.keyboard.press("ArrowDown");
  await expect(boxes.nth(1)).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(boxes.nth(1)).toBeChecked();
  expect(await boxes.evaluateAll((items) => items.every((item) => (item as HTMLElement).tabIndex === 0))).toBe(true);
});

for (const selectedIndex of [1, 2]) {
  test(`real option details follow the radio Tab entry (selected option ${selectedIndex + 1})`, async ({ page }) => {
    await openQuestion(page);
    const radios = page.getByRole("radio");
    const selected = radios.nth(selectedIndex);
    const collapse = page.getByRole("button", { name: "Collapse", exact: true });
    const custom = page.getByRole("button", { name: /Type something/ });
    await selected.click();
    await collapse.focus();
    await page.keyboard.press("Tab");
    await expect(selected).toBeFocused();
    await expect(selected).toBeChecked();
    await page.keyboard.press("Shift+Tab");
    await expect(collapse).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(selected).toBeFocused();
    for (const [index, option] of questions[0]!.options.entries()) {
      await page.keyboard.press("Tab");
      const info = page.getByRole("button", { name: `Preview ${option.label}`, exact: true });
      await expect(info).toBeFocused();
      // Subgrid keeps each detail trigger centered beside even a wrapped label.
      const radioBox = (await radios.nth(index).boundingBox())!;
      const infoBox = (await info.boundingBox())!;
      expect(Math.abs(radioBox.y + radioBox.height / 2 - infoBox.y - infoBox.height / 2)).toBeLessThanOrEqual(1);
      await page.keyboard.press("Enter");
      const details = page.getByRole("dialog", { name: `Preview ${option.label}`, exact: true });
      await expect(details).toBeVisible();
      await expect(details).toContainText(option.description);
      if (index === 0) await expect(details.getByRole("heading", { name: "Analysis plan" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(details).toBeHidden();
      await expect(info).toBeFocused();
      await expect(selected).toBeChecked();
    }
    await page.keyboard.press("Tab");
    await expect(custom).toBeFocused();
    for (const option of [...questions[0]!.options].reverse()) {
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByRole("button", { name: `Preview ${option.label}`, exact: true })).toBeFocused();
    }
    await page.keyboard.press("Shift+Tab");
    await expect(selected).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(collapse).toBeFocused();
  });
}
