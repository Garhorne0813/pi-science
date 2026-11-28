import { test, expect } from "@playwright/test";
import { waitForConversationSettled } from "./fixtures/app.fixture";
import { VISUAL_CWD, VISUAL_SESSION } from "./fixtures/data.mjs";

const root = `/workspace/${encodeURIComponent(VISUAL_CWD)}`;
const PANEL = "#workspace-context-panel";
const TOGGLE = /^(Expand|Collapse) sidebar$/;
const KNOWLEDGE = /^Memory/;

test("desktop sidebar presents one stable navigation column", async ({ page }, testInfo) => {
  test.skip(!["desktop-light", "tablet"].includes(testInfo.project.name), "Desktop sidebar coverage");
  await page.goto(`${root}/memory`);
  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Switch project" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "New conversation" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Files", exact: true })).toBeVisible();
  await expect(panel.getByRole("link", { name: KNOWLEDGE })).toHaveAttribute("aria-current", "page");
  await expect(panel.getByRole("link", { name: "Run history", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.locator("[data-workspace-rail-slot]")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("sidebar-expanded.png") });
});

test("collapsed sidebar restores focus and the same conversation state", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "Desktop interaction coverage");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  await waitForConversationSettled(page);
  const panel = page.locator(PANEL);
  const search = page.getByRole("searchbox");
  await search.fill("Data");
  await expect(page.getByRole("button", { name: "Data analysis notes", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect(panel).toHaveAttribute("hidden");
  const expand = page.getByRole("button", { name: "Expand sidebar", exact: true });
  await expect(expand).toBeFocused();
  await expand.click();
  await expect(panel).toBeVisible();
  await expect(search).toHaveValue("Data");
  await expect(page.getByRole("button", { name: "Data analysis notes", exact: true })).toBeVisible();
});

test("conversation actions remain keyboard operable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "Desktop conversation coverage");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  await waitForConversationSettled(page);
  const trigger = page.getByRole("button", { name: "Manage conversation: Markdown rendering demo" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Rename conversation" })).toBeFocused();
  for (const name of ["Regenerate title with AI", "Fork conversation", "Delete conversation"]) {
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name })).toBeFocused();
  }
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("primary links highlight only their exact page", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "Desktop navigation coverage");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  const panel = page.locator(PANEL);
  await expect(panel.locator("[aria-current=page]")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Markdown rendering demo", exact: true })).toHaveAttribute("aria-current", "page");
  for (const [path, label] of [["files", "Files"], ["memory", KNOWLEDGE], ["runs", "Run history"]] as const) {
    const item = panel.getByRole("link", { name: label });
    await item.click();
    await expect(page).toHaveURL(new RegExp(`${root}/${path}$`));
    await expect(item).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "Markdown rendering demo", exact: true })).not.toHaveAttribute("aria-current", "page");
  }
});

test("new conversation keeps the sidebar available and opens a durable blank route", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "Desktop new-conversation coverage");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  await page.getByRole("searchbox").fill("Data");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}/new$`));
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveValue("Data");
});

test("mobile page navigation closes the context drawer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile navigation coverage");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  const expand = page.getByRole("button", { name: "Expand sidebar", exact: true });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expand.click();
  const panel = page.locator(PANEL);
  await expect(panel).toBeFocused();
  await panel.getByRole("link", { name: "Files", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}/files$`));
  await expect(panel).toHaveAttribute("hidden");
  await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toBeVisible();
});

test("mobile drawer closes on the shade and Escape", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile drawer coverage");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  const panel = page.locator(PANEL);
  const expand = page.getByRole("button", { name: "Expand sidebar", exact: true });
  await expand.click();
  const shade = page.locator("[data-context-panel-shade]");
  await expect(shade).toBeVisible();
  const box = await shade.boundingBox();
  await shade.click({ position: { x: box!.width - 6, y: 40 } });
  await expect(panel).toHaveAttribute("hidden");
  await expect(expand).toBeFocused();
  await expand.click();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("hidden");
  await expect(expand).toBeFocused();
});

test("sidebar switches from a mobile overlay to a desktop column at 768px", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "Breakpoint boundary");
  await page.setViewportSize({ width: 767, height: 900 });
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();
  expect(await panel.evaluate(element => getComputedStyle(element).position)).toBe("absolute");
  expect(await panel.evaluate(element => getComputedStyle(element).left)).toBe("0px");
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(panel).toBeVisible();
  expect(await panel.evaluate(element => getComputedStyle(element).position)).toBe("relative");
});

test("navigation controls fit supported sidebar widths and short windows", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "Desktop sizing coverage");
  await page.setViewportSize({ width: 1280, height: 600 });
  for (const width of [220, 320, 420]) {
    await page.addInitScript((nextWidth) => {
      localStorage.setItem("pi-science.sidebar.width", JSON.stringify(nextWidth));
    }, width);
    await page.goto(`${root}/session/${VISUAL_SESSION}`);
    const panelBox = (await page.locator(PANEL).boundingBox())!;
    expect(Math.abs(panelBox.width - width)).toBeLessThanOrEqual(1);
    for (const [role, name] of [["button", "New conversation"], ["link", "Files"], ["link", KNOWLEDGE], ["link", "Run history"], ["button", "Settings"]] as const) {
      const box = await page.getByRole(role, { name }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(panelBox.x - 1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(600);
    }
  }
});

test("mobile sidebar exposes Settings through the drawer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile settings coverage");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  await page.getByRole("button", { name: TOGGLE, exact: true }).click();
  const settings = page.locator(PANEL).getByRole("button", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await settings.click();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
});
