import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { VISUAL_CWD, VISUAL_SESSION } from "./fixtures/data.mjs";

const root = `/workspace/${encodeURIComponent(VISUAL_CWD)}`;

  const records = Array.from({ length: 125 }, (_, index) => ({
    schema_version: 1, execution_id: `exec-${index}`, kind: "tool", surface: "pi", status: index === 1 ? "failed" : "succeeded",
    workspace_id: VISUAL_CWD, producer: "fixture-observer",
    created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    started_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    ended_at: new Date(Date.UTC(2026, 0, 1, 0, index, 90)).toISOString(),
    correlation: index % 3 === 0 ? {} : { session_id: index % 3 === 1 ? VISUAL_SESSION : "other-session" },
    request: { tool: `analysis-${index}` }, result: index === 1 ? { error: "Recorded failure" } : { output_preview: "Recorded tool output" },
    runtime: { model: "fixture" }, files: { read: [], written: [] }, artifacts: [],
  })).reverse();

async function installRuns(page: Page) {
  await page.route("**/api/executions?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const scoped = records.filter((run) => !params.get("session_id") || run.correlation.session_id === params.get("session_id"));
    const filtered = scoped.filter((run) => (!params.get("search") || run.request.tool.includes(params.get("search")!)) &&
      (!params.get("kind") || run.kind === params.get("kind")) && (!params.get("status") || run.status === params.get("status")) &&
      (!params.get("from") || Date.parse(run.ended_at) >= Date.parse(params.get("from")!)) && (!params.get("to") || Date.parse(run.started_at) <= Date.parse(params.get("to")!)));
    const targetIndex = filtered.findIndex((run) => run.execution_id === params.get("target_id"));
    const offset = Number(params.get("offset") ?? 0);
    await route.fulfill({ json: { executions: filtered.slice(offset, offset + 50), total: scoped.length, filtered_total: filtered.length, offset, limit: 50,
      status_counts: { succeeded: scoped.filter((run) => run.status === "succeeded").length, failed: scoped.filter((run) => run.status === "failed").length },
      completed_duration_ms: scoped.length * 90_000, target_offset: targetIndex >= 0 ? Math.floor(targetIndex / 50) * 50 : null,
      target_matches: targetIndex >= 0, target_in_scope: scoped.some((run) => run.execution_id === params.get("target_id")) } });
  });
  await page.route("**/api/executions/*/logs?*", (route) => route.fulfill({ json: { stdout: "Recorded tool output", stderr: "", source: "preview", complete: false } }));
  await page.route(/\/api\/executions\/[^/]+\?/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const record = records.find((run) => run.execution_id === id);
    await route.fulfill({ status: record ? 200 : 404, json: record || { error: "Execution not found" } });
  });
}

test("execution history scopes, paginates, and links timeline details @accessibility", async ({ page }, testInfo) => {
  test.skip(!["desktop-light", "mobile"].includes(testInfo.project.name), "Desktop and narrow-screen coverage");
  await installRuns(page);
  await page.goto(`${root}/runs?session_id=${VISUAL_SESSION}`);
  await expect(page.getByLabel("Execution scope")).toHaveValue("session");
  await expect(page.getByRole("button", { name: "Execution timeline", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("header").getByText(/Markdown rendering demo/)).toBeVisible();
  await expect(page.getByLabel("Group by session (current page)")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /analysis-124/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /analysis-123/ })).toHaveCount(0);
  await page.getByLabel("Execution scope").selectOption("workspace");
  await expect(page.getByRole("button", { name: /analysis-123/ })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: /analysis-74\b/ })).toBeVisible();
  await page.getByLabel("Search executions").fill("analysis-0");
  await expect(page.getByRole("button", { name: /analysis-0\b/ })).toBeVisible();
  await page.getByRole("button", { name: "Execution timeline", exact: true }).click();
  await page.getByRole("button", { name: /analysis-0/ }).click();
  await expect(page.getByRole("button", { name: "Ask AI to attempt reproduction" })).toBeVisible();
  await page.getByRole("tab", { name: "Output", exact: true }).click();
  await expect(page.getByText("Recorded tool output", { exact: true })).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "Back to executions" }).click();
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  // Let the responsive detail-pane transition settle before measuring contrast.
  await page.waitForTimeout(300);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((v) => v.impact === "critical" || v.impact === "serious")).toEqual([]);
});

for (const [position, id] of [[75, "exec-50"], [125, "exec-0"]] as const) {
  test(`historical execution ${position} survives reload, mode changes and locating its page`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-light", "Historical navigation coverage");
    await installRuns(page);
    await page.goto(`${root}/runs?execution=${id}&view=timeline`);
    const detail = page.getByRole("region", { name: "Execution details" });
    await expect(detail.getByRole("heading", { name: `analysis-${id.slice(5)}`, exact: true })).toBeVisible();
    await expect(page.getByText(/outside the current page/)).toBeVisible();
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.reload();
    await expect(detail.getByRole("heading", { name: `analysis-${id.slice(5)}`, exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`execution=${id}`));
    await page.getByRole("button", { name: "Go to execution page" }).click();
    await expect(page).toHaveURL(new RegExp(`offset=${Math.floor((position - 1) / 50) * 50}`));
    await expect(page.getByRole("button", { name: new RegExp(`analysis-${id.slice(5)}\\b`) })).toBeVisible();
    await page.goBack();
    await expect(page).not.toHaveURL(/offset=/);
    await expect(detail.getByRole("heading", { name: `analysis-${id.slice(5)}`, exact: true })).toBeVisible();
  });
}

test("timeline zoom, collapsed workspace groups and keyboard selection remain usable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "Timeline interaction coverage");
  await installRuns(page);
  const listRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/executions") listRequests.push(request.url());
  });
  await page.goto(`${root}/runs?view=timeline`);
  await expect(page.getByTestId("timeline-exec-124")).toBeVisible();
  await expect(page.locator("time")).not.toHaveCount(2);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByTestId("timeline-canvas")).toHaveCSS("width", /px$/);
  await expect(page.getByText("2×", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByText("4×", { exact: true })).toBeVisible();
  const timeline = page.getByRole("region", { name: "Execution timeline" });
  const otherGroup = timeline.getByRole("button", { name: /other-session/ });
  await otherGroup.click();
  const requestCount = listRequests.length;
  expect(requestCount).toBe(1);
  for (const id of [121, 118, 124]) {
    const row = timeline.getByRole("button", { name: new RegExp(`analysis-${id}\\b`) });
    await row.click();
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("region", { name: "Execution details" }).getByRole("heading", { name: `analysis-${id}`, exact: true })).toBeVisible();
    await expect(page.getByText("4×", { exact: true })).toBeVisible();
    await expect(otherGroup).toHaveAttribute("aria-expanded", "false");
    expect(listRequests).toHaveLength(requestCount);
  }
  await page.getByRole("button", { name: "Fit range" }).click();
  const group = page.getByRole("region", { name: "Execution timeline" }).getByRole("button", { name: /Markdown rendering demo/ });
  await group.click();
  await expect(page.getByTestId("timeline-exec-124")).toHaveCount(0);
  await group.click();
  const row = page.getByRole("button", { name: /analysis-124\b/ });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("aria-current", "true");
});

test("long concurrent, zero and unknown intervals stay readable @accessibility", async ({ page }, testInfo) => {
  test.skip(!["desktop-light", "mobile"].includes(testInfo.project.name), "Timeline edge coverage");
  await page.clock.install({ time: new Date("2026-01-03T00:00:00Z") });
  const base = records[0]!;
  const edge = [
    { ...base, execution_id: "long", kind: "job", status: "running", started_at: "2026-01-01T00:00:00Z", ended_at: undefined, request: { command: ["python", "research_pipeline.py", "--input", "data/large-expression-matrix.csv"] } },
    { ...base, execution_id: "failed", kind: "job", status: "failed", started_at: "2026-01-01T09:00:00Z", ended_at: "2026-01-01T10:00:00Z", request: { command: ["python", "a_very_long_evaluation_command.py", "--input", "data/a_very_long_input_filename_that_should_wrap_on_small_screens.csv"] }, result: { error: "Input data unavailable" } },
    { ...base, execution_id: "zero", started_at: "2026-01-01T12:00:00Z", ended_at: "2026-01-01T12:00:00Z", request: { tool: "zero-duration check" } },
    { ...base, execution_id: "unknown", started_at: undefined, ended_at: undefined, correlation: {}, request: { tool: "unknown-time execution" } },
  ];
  await page.route("**/api/executions?*", (route) => route.fulfill({ json: { executions: edge, total: 4, filtered_total: 4, status_counts: { succeeded: 2, failed: 1, running: 1 }, completed_duration_ms: 3_600_000, completed_duration_count: 2 } }));
  await page.route(/\/api\/executions\/[^/]+\?/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    return route.fulfill({ json: edge.find((run) => run.execution_id === id) });
  });
  await page.goto(`${root}/runs?view=timeline&execution=failed`);
  if (testInfo.project.name === "mobile") await page.getByRole("button", { name: "Back to executions" }).click();
  await expect(page.getByTestId("timeline-zero")).toBeVisible();
  await expect(page.getByText("Timing unavailable", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Execution timeline").getByText(/Running/)).toBeVisible();
  const unknown = page.getByRole("button", { name: /unknown-time execution/ });
  await unknown.click();
  await expect(page.getByRole("heading", { name: "unknown-time execution" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.waitForTimeout(300);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((v) => v.impact === "critical" || v.impact === "serious")).toEqual([]);
});
