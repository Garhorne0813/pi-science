import { test, expect } from "@playwright/test";
import { VISUAL_CWD, VISUAL_SESSION } from "./fixtures/data.mjs";

const root = `/workspace/${encodeURIComponent(VISUAL_CWD)}`;

test("sidebar tabs preserve session lifecycle and collapsed New stays blank", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "Desktop interaction coverage");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  await expect(page.getByRole("button", { name: "Markdown rendering demo", exact: true })).toBeVisible();
  let reloads = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/sessions" && request.method() === "GET") reloads++;
  });
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(page.getByRole("button", { name: "README.md", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Conversations", exact: true }).click();
  await page.getByRole("searchbox").fill("Data");
  await expect(page.getByRole("button", { name: "Data analysis notes", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Markdown rendering demo", exact: true })).toHaveCount(0);
  await page.getByRole("searchbox").clear();
  const trigger = page.getByRole("button", { name: "Manage conversation: Markdown rendering demo" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Fork conversation" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Delete conversation" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "Close sidebar", exact: true }).last().click();
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}$`));
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}$`));
  expect(reloads).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 600 });
  for (const name of ["Project Knowledge", "Research", "Run history", "Settings"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(600);
  }
});

test("mobile file navigation closes the sidebar drawer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile interaction coverage");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: /View all files/ }).click();
  await expect(page).toHaveURL(new RegExp(`${root}/files$`));
  await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeHidden();
});


test("collapsed conversations only highlight conversation routes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "Desktop navigation coverage");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  await page.getByRole("button", { name: "Close sidebar", exact: true }).last().click();
  const conversations = page.getByRole("button", { name: "Conversations", exact: true });
  await expect(conversations).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}$`));
  await expect(conversations).toHaveAttribute("aria-current", "page");
  for (const [path, label] of [["files", "Files"], ["knowledge", "Project Knowledge"], ["research", "Research"], ["runs", "Run history"]]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${root}/${path}$`));
    await expect(conversations).not.toHaveAttribute("aria-current", "page");
    await expect(conversations).not.toHaveClass(/bg-surface-selected/);
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
  }
});

test("embedded file polling stops while the sidebar or file tab is hidden", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "Desktop polling coverage");
  await page.clock.install();
  let fileRequests = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/files" && request.method() === "GET") fileRequests++;
  });
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(page.getByRole("button", { name: "README.md", exact: true })).toBeVisible();
  const initial = fileRequests;
  await page.clock.runFor(4_000);
  await expect.poll(() => fileRequests).toBeGreaterThan(initial);
  await page.getByRole("button", { name: "Close sidebar", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toBeVisible();
  const collapsed = fileRequests;
  await page.clock.runFor(6_000);
  expect(fileRequests).toBe(collapsed);
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await expect.poll(() => fileRequests).toBeGreaterThan(collapsed);
  await page.getByRole("tab", { name: "Conversations", exact: true }).click();
  const conversations = fileRequests;
  await page.clock.runFor(6_000);
  expect(fileRequests).toBe(conversations);
});
