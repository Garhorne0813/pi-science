import { test, expect } from "@playwright/test";
import { FIXTURES, VISUAL_CWD, VISUAL_SESSION } from "./fixtures/data.mjs";

const root = `/workspace/${encodeURIComponent(VISUAL_CWD)}`;
const RAIL = 'nav[aria-label="Primary navigation"]';
const PANEL = "#workspace-context-panel";
const TOGGLE = "Workspace context panel";
// The Rail's Knowledge link folds the pending count into its accessible name,
// so it is matched by prefix rather than exactly.
const KNOWLEDGE = /^Project Knowledge/;

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
  await page.getByRole("searchbox").fill("Data");
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  // The Rail's New-conversation action is the only one, and it works with the
  // panel closed: collapsing the panel must not take the entry away.
  await page.getByRole("button", { name: TOGGLE, exact: true }).click();
  await expect(page.locator(PANEL)).toHaveAttribute("hidden");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}$`));
  await expect(page.locator(PANEL)).toHaveAttribute("hidden");
  await page.getByRole("button", { name: TOGGLE, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}$`));
  await expect(page.getByRole("tab", { name: "Conversations", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("searchbox")).toHaveValue("");
  expect(reloads).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 600 });
  for (const name of [/^Project Knowledge/, "Research", "Run history", "Settings"]) {
    const box = await page.getByRole("link", { name }).or(page.getByRole("button", { name })).first().boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(600);
  }
});

test("mobile file navigation closes the context drawer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile interaction coverage");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  const toggle = page.getByRole("button", { name: TOGGLE, exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: /View all files/ }).click();
  await expect(page).toHaveURL(new RegExp(`${root}/files$`));
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(PANEL)).toHaveAttribute("hidden");
});

test("rail navigation highlights only exact primary routes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "Desktop navigation coverage");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  const rail = page.locator(RAIL);
  const conversations = rail.getByRole("link", { name: "Conversations", exact: true });
  await expect(conversations).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}$`));
  await expect(conversations).toHaveAttribute("aria-current", "page");
  for (const [path, label] of [["knowledge", KNOWLEDGE], ["research", "Research"], ["runs", "Run history"]] as const) {
    const item = rail.getByRole("link", { name: label });
    await item.click();
    await expect(page).toHaveURL(new RegExp(`${root}/${path}$`));
    await expect(conversations).not.toHaveAttribute("aria-current", "page");
    await expect(conversations).not.toHaveClass(/bg-surface-selected/);
    await expect(item).toHaveAttribute("aria-current", "page");
  }
  // The full Files route has no Rail entry, so nothing may claim to be current
  // there. The Files context tab still shows where the user is working.
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: /View all files/ }).click();
  await expect(page).toHaveURL(new RegExp(`${root}/files$`));
  await expect(rail.locator("[aria-current]")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("research with files and runs with conversations stay simultaneously current", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "Desktop selection coverage");
  await page.goto(`${root}/research`);
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(page.locator(RAIL).getByRole("link", { name: "Research", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(new RegExp(`${root}/research$`));
  // Routing away through the Rail must not reset the context tab. A reload
  // would, because the tab is session-only by design, so drive the app.
  await page.locator(RAIL).getByRole("link", { name: "Run history", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}/runs$`));
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(RAIL).getByRole("link", { name: "Run history", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("tab", { name: "Conversations", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Conversations", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(RAIL).getByRole("link", { name: "Run history", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(new RegExp(`${root}/runs$`));
});

test("embedded file polling stops while the panel or file tab is hidden", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "Desktop polling coverage");
  // Return actual directory children so visible descendants prove folders stayed expanded.
  await page.route("**/api/files**", route => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/files") return route.continue();
    const subdir = url.searchParams.get("subdir") || "";
    const entries = FIXTURES.files.filter(entry => {
      const slash = entry.path.lastIndexOf("/");
      return (slash < 0 ? "" : entry.path.slice(0, slash)) === subdir;
    });
    return route.fulfill({ json: entries });
  });
  await page.clock.install();
  let fileRequests = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/files" && request.method() === "GET") fileRequests++;
  });
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  const toggle = page.getByRole("button", { name: TOGGLE, exact: true });
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(page.getByRole("button", { name: "README.md", exact: true })).toBeVisible();
  const files = page.getByRole("tabpanel", { includeHidden: true }).filter({ has: page.getByRole("button", { name: /View all files/, includeHidden: true }) });
  await files.getByRole("button", { name: "data", exact: true }).click();
  await expect(files.getByRole("button", { name: "shikimate.csv", exact: true })).toBeVisible();
  await files.getByRole("button", { name: "analysis", exact: true }).click();
  await expect(files.getByRole("button", { name: "report.md", exact: true })).toBeVisible();
  const initial = fileRequests;
  await page.clock.runFor(4_000);
  await expect.poll(() => fileRequests).toBeGreaterThan(initial);
  await toggle.click();
  await expect(page.locator(PANEL)).toHaveAttribute("hidden");
  const collapsed = fileRequests;
  await page.clock.runFor(6_000);
  expect(fileRequests).toBe(collapsed);
  await toggle.click();
  await expect.poll(() => fileRequests).toBeGreaterThan(collapsed);
  await page.getByRole("tab", { name: "Conversations", exact: true }).click();
  const conversations = fileRequests;
  await page.clock.runFor(6_000);
  expect(fileRequests).toBe(conversations);
  // Hidden panels remain mounted, preserving both directory expansions.
  await expect(files.getByRole("button", { name: "shikimate.csv", exact: true, includeHidden: true })).toHaveCount(1);
  await expect(files.getByRole("button", { name: "report.md", exact: true, includeHidden: true })).toHaveCount(1);
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(files.getByRole("button", { name: "shikimate.csv", exact: true })).toBeVisible();
  await expect(files.getByRole("button", { name: "report.md", exact: true })).toBeVisible();
  await expect.poll(() => fileRequests).toBeGreaterThan(conversations);
});

test("collapsed Conversations restores the tab and clears search", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "Desktop navigation coverage");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  await page.getByRole("searchbox").fill("Data");
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: TOGGLE, exact: true }).click();
  await expect(page.locator(PANEL)).toHaveAttribute("hidden");
  await page.locator(RAIL).getByRole("link", { name: "Conversations", exact: true }).click();
  await page.getByRole("button", { name: TOGGLE, exact: true }).click();
  await expect(page.getByRole("tab", { name: "Conversations", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("searchbox")).toHaveValue("");
});

test("the rail is operable while the mobile drawer is open and navigating closes it", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile drawer coverage");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  const toggle = page.getByRole("button", { name: TOGGLE, exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const runs = page.locator(RAIL).getByRole("link", { name: "Run history", exact: true });
  await expect(runs).toBeVisible();
  await runs.click();
  await expect(page).toHaveURL(new RegExp(`${root}/runs$`));
  await expect(runs).toHaveAttribute("aria-current", "page");
  await expect(page.locator(PANEL)).toHaveAttribute("hidden");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("the mobile drawer closes on the shade and on Escape", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile drawer coverage");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  const toggle = page.getByRole("button", { name: TOGGLE, exact: true });
  const panel = page.locator(PANEL);
  await toggle.click();
  await expect(panel).toBeVisible();
  // The shade covers Main only; it never covers the rail.
  const shade = page.locator("[data-context-panel-shade]");
  await expect(shade).toBeVisible();
  const shadeBox = await shade.boundingBox();
  const railBox = await page.locator(RAIL).boundingBox();
  expect(shadeBox!.x).toBeGreaterThanOrEqual(railBox!.x + railBox!.width - 1);
  // Clicking the free strip of shade to the right of the panel dismisses it.
  const shadeWidth = shadeBox!.width;
  await shade.click({ position: { x: shadeWidth - 6, y: 40 } });
  await expect(panel).toHaveAttribute("hidden");
  await expect(toggle).toBeFocused();
  await toggle.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("hidden");
  await expect(toggle).toBeFocused();
});

test("the mobile drawer removes background inspector controls from focus", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile focus containment");
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  await page.getByRole("button", { name: TOGGLE, exact: true }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  const panel = page.locator(PANEL);
  await panel.getByRole("button", { name: "report.md", exact: true }).click();
  await expect(page.locator('[data-variant="file"]')).toBeVisible();
  // An explicit focus() call must not reach an inspector control.
  const explicit = await page.evaluate(() => {
    const preview = document.querySelector('[data-variant="file"]') as HTMLElement | null;
    const inertAncestor = preview?.closest("[inert]");
    const button = preview?.querySelector("button") as HTMLButtonElement | null ?? null;
    if (!inertAncestor || !button) return { inertAncestor: !!inertAncestor, button: !!button, landedInside: null as boolean | null };
    button.focus();
    return { inertAncestor: true, button: true, landedInside: !!document.activeElement?.closest('[data-variant="file"]') };
  });
  expect(explicit.inertAncestor).toBe(true);
  expect(explicit.button).toBe(true);
  expect(explicit.landedInside).toBe(false);
  // Tabbing must never land inside the inspector either.
  await panel.click({ position: { x: 20, y: 120 } });
  for (let press = 0; press < 12; press++) {
    await page.keyboard.press("Tab");
    const insideInspector = await page.evaluate(() => !!document.activeElement?.closest('[data-variant="file"]'));
    expect(insideInspector).toBe(false);
  }
});

test("the panel overlays main below 768px and is an in-flow column at 768px", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "Breakpoint boundary");
  await page.setViewportSize({ width: 767, height: 900 });
  await page.goto(`${root}/session/${VISUAL_SESSION}`);
  const toggle = page.getByRole("button", { name: TOGGLE, exact: true });
  const panel = page.locator(PANEL);
  // A narrow viewport starts with the panel closed so it cannot cover Main.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(panel).toBeVisible();
  const narrow = await page.evaluate((selector) => {
    const rail = document.querySelector('nav[aria-label="Primary navigation"]')!.getBoundingClientRect();
    const aside = document.querySelector(selector) as HTMLElement;
    // Read the CSS offset, not the animated rect: the panel entrance
    // animation translates its box for the first 200ms.
    return { rail: rail.width, position: getComputedStyle(aside).position, left: getComputedStyle(aside).left };
  }, PANEL);
  expect(narrow.rail).toBe(58);
  expect(narrow.position).toBe("absolute");
  expect(narrow.left).toBe("58px");
  // 768px turns the same element into an in-flow column and keeps the user's
  // open choice; it does not close or reopen behind their back.
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const wide = await page.evaluate((selector) => {
    const rail = document.querySelector('nav[aria-label="Primary navigation"]')!.getBoundingClientRect();
    const aside = document.querySelector(selector) as HTMLElement;
    return { rail: rail.width, position: getComputedStyle(aside).position, width: aside.getBoundingClientRect().width };
  }, PANEL);
  expect(wide.rail).toBe(60);
  expect(wide.position).toBe("relative");
  expect(wide.width).toBe(240);
});

test("panel and rail controls fit narrow panel widths and short light/dark windows", async ({ page }, testInfo) => {
  test.skip(!["desktop-light", "desktop-dark"].includes(testInfo.project.name), "Desktop visual acceptance");
  await page.setViewportSize({ width: 1280, height: 600 });
  for (const width of [220, 240, 320, 420]) {
    await page.addInitScript(({ width, theme }) => {
      localStorage.setItem("pi-science.sidebar.width", JSON.stringify(width));
      localStorage.setItem("pi-science.theme", JSON.stringify(theme));
    }, { width, theme: testInfo.project.name === "desktop-dark" ? "dark" : "light" });
    await page.goto(`${root}/session/${VISUAL_SESSION}`);
    await expect(page.getByRole("searchbox")).toBeVisible();
    const railBox = (await page.locator(RAIL).boundingBox())!;
    // Every primary entry stays inside the rail column.
    for (const [role, name] of [["button", "New conversation"], ["link", /^Project Knowledge/], ["link", "Research"], ["link", "Run history"], ["button", "Settings"]] as const) {
      const box = await page.getByRole(role, { name }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(railBox.x - 1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(railBox.x + railBox.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(600);
    }
    // The panel's own controls stay inside the panel column.
    const panelBox = (await page.locator(PANEL).boundingBox())!;
    // Fractional layout widths are expected at this scale; allow one pixel.
    expect(Math.abs(panelBox.width - width)).toBeLessThanOrEqual(1);
    for (const label of ["Conversations", "Files"]) {
      const box = await page.getByRole("tab", { name: label, exact: true }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(panelBox.x - 1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
    }
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect(page.getByRole("button", { name: "README.md", exact: true })).toBeVisible();
    const viewAll = await page.getByRole("button", { name: /View all files/ }).boundingBox();
    expect(viewAll!.x + viewAll!.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
    await page.getByRole("tab", { name: "Conversations", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`sidebar-${width}.png`) });
  }
});
