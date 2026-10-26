import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { resolveBrowserExecutable } from "./browser-executable.mjs";
const frontend = process.env.PI_SCIENCE_FRONTEND_URL || "http://127.0.0.1:8787";
const backend = process.env.PI_SCIENCE_BACKEND_URL || frontend;
const workspace = path.join(
  os.tmpdir(),
  `pi-science-memory-uat-${process.pid}`,
);
const outputs = process.env.PI_SCIENCE_UAT_OUTPUT_DIR || os.tmpdir();
const query = "?cwd=" + encodeURIComponent(workspace);
const token = process.env.PI_SCIENCE_INTERNAL_TOKEN;
const headers = {
  "content-type": "application/json",
  ...(token ? { "x-pi-science-internal-token": token } : {}),
};
async function api(route, method = "GET", body) {
  const r = await fetch(
    backend +
      "/api/memory" +
      route +
      (route.includes("?") ? "&cwd=" + encodeURIComponent(workspace) : query),
    {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  assert.ok(r.ok, `${route}: ${r.status} ${!r.ok ? await r.text() : ""}`);
  return r.json();
}
let browser, originalSettings;
const records = [];
try {
  await mkdir(path.join(workspace, ".pi-science"), { recursive: true });
  await mkdir(outputs, { recursive: true });
  await writeFile(
    path.join(workspace, "PROJECT.md"),
    "# Ordinary project documentation\n",
  );
  await writeFile(
    path.join(workspace, "result.csv"),
    "condition,value\nA,12\nB,14\n",
  );
  originalSettings = await api("/settings");
  const { revision, ...settings } = originalSettings;
  await api("/settings", "PATCH", {
    expectedRevision: revision,
    settings: {
      ...settings,
      enabled: true,
      extraction: { ...settings.extraction, enabled: false },
      dream: { ...settings.dream, enabled: false },
    },
  });
  for (const content of [
    {
      scope: "project",
      kind: "preference",
      title: "Reply language",
      body: "User prefers concise replies",
      evidenceLevel: "user_stated",
      sources: [],
    },
    {
      scope: "project",
      kind: "finding",
      title: "Preliminary measurement",
      body: "Observed difference is exploratory and requires independent replication.",
      evidenceLevel: "observed",
      sources: [{ kind: "file", locator: "result.csv" }],
    },
  ])
    records.push((await api("/records", "POST", { content })).record);
  browser = await chromium.launch({
    executablePath: await resolveBrowserExecutable(),
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    ...(token
      ? { extraHTTPHeaders: { "x-pi-science-internal-token": token } }
      : {}),
  });
  const page = await context.newPage();
  await page.goto(
    frontend + "/workspace/" + encodeURIComponent(workspace) + "/memory",
  );
  await page.getByRole("heading", { name: "Memory", exact: true }).waitFor();
  await page.getByText("Reply language", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Pending review (1)", exact: true })
    .click();
  const card = page
    .locator("article")
    .filter({ hasText: "Preliminary measurement" });
  await card.locator("summary").click();
  await card.getByRole("button", { name: "Approve this version" }).click();
  await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
  const approved = (await api("/records/" + records[1].id)).record;
  assert.equal(approved.status, "active");
  assert.equal(approved.approvedContentHash, approved.contentHash);
  assert.equal(approved.revision, records[1].revision);
  assert.equal(
    await readFile(path.join(workspace, "PROJECT.md"), "utf8"),
    "# Ordinary project documentation\n",
  );
  // Exercise user CRUD through the real editor and more-actions menu.
  await page.getByRole("button", { name: "Memories", exact: true }).click();
  await page
    .getByRole("button", { name: "Create memory", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("BrowserCrudProbe");
  await page
    .getByRole("textbox", { name: "Body", exact: true })
    .fill("User prefers concise replies");
  const recordResponse = (method) =>
    page.waitForResponse(
      (r) =>
        r.request().method() === method &&
        new URL(r.url()).pathname.startsWith("/api/memory/records"),
    );
  const createdResponse = recordResponse("POST");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const created = await (await createdResponse).json();
  assert.ok(created.record?.id, JSON.stringify(created));
  records.push(created.record);
  const probe = page.locator("article").filter({ hasText: "BrowserCrudProbe" });
  await probe.waitFor();
  const search = page.getByRole("textbox", {
    name: "Search memories",
    exact: true,
  });
  const searchResponse = recordResponse("GET");
  await search.fill("BrowserCrudProbe");
  await searchResponse;
  await page.waitForFunction(
    () => document.querySelectorAll("main article").length === 1,
  );
  assert.equal(await page.locator("article").count(), 1);
  await search.fill("");
  const actions = async (action) => {
    await probe
      .getByRole("button", {
        name: "More actions: BrowserCrudProbe",
        exact: true,
      })
      .click();
    await page.getByRole("menuitem", { name: action, exact: true }).click();
  };
  await actions("Edit");
  await page
    .getByRole("textbox", { name: "Body", exact: true })
    .fill("User prefers concise reply formatting");
  const editedResponse = recordResponse("PATCH");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const edited = await (await editedResponse).json();
  assert.equal(edited.record?.body, "User prefers concise reply formatting");
  assert.equal(edited.record.revision, created.record.revision + 1);
  await probe.locator("summary").click();
  const historyResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" &&
      new URL(r.url()).pathname ===
        `/api/memory/records/${created.record.id}/history`,
  );
  await probe
    .getByRole("button", { name: "Version and review history", exact: true })
    .click();
  const history = await (await historyResponse).json();
  assert.equal(history.revisions.length, 2);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const archivedResponse = recordResponse("POST");
  await actions("Archive");
  const archived = await (await archivedResponse).json();
  assert.equal(archived.record.status, "archived");
  await probe.getByText("Archived", { exact: true }).waitFor();
  page.once("dialog", (dialog) => dialog.dismiss());
  await actions("Permanently delete");
  assert.equal(
    (await api("/records/" + created.record.id)).record.id,
    created.record.id,
  );
  const deletedResponse = recordResponse("DELETE");
  page.once("dialog", (dialog) => dialog.accept());
  await actions("Permanently delete");
  assert.ok((await deletedResponse).ok());
  records.splice(
    records.findIndex((r) => r.id === created.record.id),
    1,
  );
  await probe.waitFor({ state: "detached" });
  const missing = await fetch(
    backend + "/api/memory/records/" + created.record.id + query,
    { headers },
  );
  assert.equal(missing.status, 404);
  const list = await api("/records?q=BrowserCrudProbe");
  assert.equal(list.records.length, 0);
  console.log(
    "PASS: browser create, keyword search, edit, revision history, archive, delete cancellation, hard delete and 404 after deletion",
  );
  const browseFixtures = [];
  const categoryName = `Browse group ${process.pid}`;
  const category = await api("/categories", "POST", {
    name: categoryName,
    autoRecall: true,
  });
  for (let n = 0; n < 43; n++) {
    let r = (
      await api("/records", "POST", {
        content: {
          scope: "project",
          kind: n % 2 === 0 ? "preference" : "workflow",
          title: `BrowseProbe ${String(n).padStart(2, "0")}`,
          body: "User prefers concise reply formatting",
          evidenceLevel: "user_stated",
          sources: [],
          ...(n % 2 === 0 ? { categoryId: category.id } : {}),
        },
      })
    ).record;
    records.push(r);
    browseFixtures.push(r);
    if (n === 0)
      await api(`/records/${r.id}/archive`, "POST", {
        expectedRevision: r.revision,
        contentHash: r.contentHash,
      });
  }
  await page.reload();
  await page.getByText("45 memories", { exact: true }).waitFor();
  const browseSearch = page.getByRole("textbox", {
    name: "Search memories",
    exact: true,
  });
  await browseSearch.fill("BrowseProbe");
  await page.getByText("43 memories", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Sort: Relevance", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText("Page 2 of 3", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText("Page 3 of 3", { exact: true }).waitFor();
  assert.equal(await page.locator("article").count(), 3);
  const choose = async (label, option) => {
    await page
      .getByRole("button", { name: new RegExp("^" + label + ":") })
      .click();
    await page
      .getByRole("menuitemradio", { name: option, exact: true })
      .click();
  };
  await choose("Status", "Active");
  await page.getByText("42 memories", { exact: true }).waitFor();
  await page.getByText("Page 1 of 3", { exact: true }).waitFor();
  await choose("Type", "Preference");
  await page.getByText("21 memories", { exact: true }).waitFor();
  await choose("Scope", "Project");
  await choose("Category", categoryName);
  await choose("Sort", "Recently created");
  const expected = await api(
    `/records?q=BrowseProbe&status=active&kind=preference&scope=project&categoryId=${encodeURIComponent(category.id)}&sort=created_desc&page=1&pageSize=20`,
  );
  await page.getByText(expected.records[0].title, { exact: true }).waitFor();
  const visible = await page.locator("article h2").allTextContents();
  assert.deepEqual(
    visible,
    expected.records.map((r) => r.title),
  );
  await page.screenshot({
    path: path.join(outputs, "memory-filters-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  const sidebarToggle = page.getByRole("button", {
    name: /^(Expand|Collapse) sidebar$/,
  });
  if (
    (await sidebarToggle.count()) &&
    (await sidebarToggle.getAttribute("aria-expanded")) === "true"
  )
    await sidebarToggle.click();
  await page.screenshot({
    path: path.join(outputs, "memory-mobile-list.png"),
    fullPage: true,
  });
  const firstCardTop = await page
    .locator("article")
    .first()
    .evaluate((el) => el.getBoundingClientRect().top);
  assert.ok(
    firstCardTop < 400,
    `Mobile controls push records too far down: ${firstCardTop}`,
  );
  await page
    .getByRole("button", { name: "Filters and sorting", exact: true })
    .click();
  let sheet = page.getByRole("dialog", {
    name: "Filters and sorting",
    exact: true,
  });
  await sheet
    .getByRole("button", { name: `Category: ${categoryName}`, exact: true })
    .waitFor();
  const originalUrl = page.url();
  await sheet
    .getByRole("button", { name: "Status: Active", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Archived", exact: true })
    .click();
  assert.equal(page.url(), originalUrl);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Filters and sorting", exact: true })
    .click();
  sheet = page.getByRole("dialog", {
    name: "Filters and sorting",
    exact: true,
  });
  await sheet
    .getByRole("button", { name: "Status: Active", exact: true })
    .waitFor();
  await page.screenshot({
    path: path.join(outputs, "memory-filters-mobile.png"),
    fullPage: true,
  });
  await sheet
    .getByRole("button", { name: "Status: Active", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Archived", exact: true })
    .click();
  assert.equal(page.url(), originalUrl);
  await sheet
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await sheet.waitFor({ state: "detached" });
  await page.getByText("1 memory", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Filters and sorting", exact: true })
    .click();
  sheet = page.getByRole("dialog", {
    name: "Filters and sorting",
    exact: true,
  });
  await sheet.getByRole("button", { name: "Reset", exact: true }).click();
  assert.ok(new URL(page.url()).searchParams.get("status") === "archived");
  await sheet
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await page.getByText("43 memories", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Filters and sorting", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "Filters and sorting", exact: true })
    .waitFor({ state: "detached" });
  console.log(
    `PASS: mobile first record at ${firstCardTop}px; draft/cancel/apply/reset/Escape`,
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page.getByText("45 memories", { exact: true }).waitFor();
  assert.equal(await browseSearch.inputValue(), "");
  await browseSearch.fill("ImpossibleProbeThatDoesNotExist");
  await page
    .getByText("No memories match these filters.", { exact: true })
    .waitFor();
  await page.getByText("0 memories", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page.getByText("45 memories", { exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const r of browseFixtures) {
    const current = (await api(`/records/${r.id}`)).record;
    await api(`/records/${r.id}`, "DELETE", {
      expectedRevision: current.revision,
      contentHash: current.contentHash,
    });
    records.splice(
      records.findIndex((record) => record.id === r.id),
      1,
    );
  }
  await page.reload();
  await page.getByText("2 memories", { exact: true }).waitFor();
  console.log(
    "PASS: complete-match count, paging, combined filters, global sorting, clear, empty results and mobile filter panel",
  );
  await page
    .getByRole("button", { name: "Memory settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("tab", { name: "Memory", exact: true }).waitFor();
  assert.equal(
    await dialog
      .getByRole("tab", { name: "Memory", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  await dialog
    .getByRole("button", { name: "Review mode: Smart review (recommended)" })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Review everything manually" })
    .click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByRole("status").filter({ hasText: "Saved" }).waitFor();
  assert.equal((await api("/settings")).review.mode, "all_manual");
  await page.screenshot({
    path: path.join(outputs, "memory-settings.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Memories", exact: true }).click();
  await page.getByText("Preliminary measurement", { exact: true }).waitFor();
  const compactCard = page
    .locator("article")
    .filter({ hasText: "Preliminary measurement" });
  const compactHeight = await compactCard.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  assert.ok(compactHeight <= 130, `Short memory is too tall: ${compactHeight}`);
  assert.equal(
    await compactCard
      .getByRole("button", { name: "Version and review history" })
      .count(),
    0,
  );
  const summary = compactCard.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await compactCard
    .getByRole("button", { name: "Version and review history" })
    .waitFor();
  await compactCard.getByText(/file: result.csv/).waitFor();
  await page.screenshot({
    path: path.join(outputs, "memory-expanded.png"),
    fullPage: true,
  });
  await summary.click();
  await compactCard
    .getByRole("button", { name: "More actions: Preliminary measurement" })
    .click();
  for (const name of ["Edit", "Archive", "Permanently delete"])
    await page.getByRole("menuitem", { name, exact: true }).waitFor();
  await page.keyboard.press("Escape");
  console.log(
    `Compact memory height: ${compactHeight}px; details and action menu verified`,
  );
  await page.screenshot({
    path: path.join(outputs, "memory-desktop.png"),
    fullPage: true,
  });
  await page.evaluate(() =>
    localStorage.setItem("pi-science.theme", JSON.stringify("dark")),
  );
  await page.reload();
  await page.getByText("Preliminary measurement", { exact: true }).waitFor();
  await page.screenshot({
    path: path.join(outputs, "memory-dark.png"),
    fullPage: true,
  });
  await page.evaluate(() =>
    localStorage.setItem("pi-science.theme", JSON.stringify("light")),
  );
  await page.reload();
  await page.getByText("Preliminary measurement", { exact: true }).waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  const toggle = page.getByRole("button", {
    name: /^(Expand|Collapse) sidebar$/,
  });
  if (
    (await toggle.count()) &&
    (await toggle.getAttribute("aria-expanded")) === "true"
  )
    await toggle.click();
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  assert.ok(
    dimensions.width <= dimensions.viewport,
    `Mobile overflow: ${JSON.stringify(dimensions)}`,
  );
  const clipped = await page
    .locator("main")
    .last()
    .evaluate((main) =>
      [...main.querySelectorAll("button,input,select,textarea")]
        .filter((element) => {
          const r = element.getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            (r.left < 0 || r.right > window.innerWidth + 1)
          );
        })
        .map(
          (element) =>
            element.textContent || element.getAttribute("aria-label"),
        ),
    );
  assert.deepEqual(
    clipped,
    [],
    `Mobile controls are clipped: ${JSON.stringify(clipped)}`,
  );
  await page.screenshot({
    path: path.join(outputs, "memory-mobile.png"),
    fullPage: true,
  });
  console.log(
    "PASS: Memory UI, exact-version scientific approval, settings CAS, unchanged PROJECT.md, desktop/mobile layout",
  );
} finally {
  await browser?.close();
  for (const r of records) {
    const current = (await api("/records/" + r.id)).record;
    await api("/records/" + r.id, "DELETE", {
      expectedRevision: current.revision,
      contentHash: current.contentHash,
    });
  }
  if (originalSettings) {
    const current = await api("/settings");
    const { revision: _, ...settings } = originalSettings;
    await api("/settings", "PATCH", {
      expectedRevision: current.revision,
      settings,
    });
  }
  await rm(workspace, { recursive: true, force: true });
}
