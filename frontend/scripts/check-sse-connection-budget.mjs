import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { resolveBrowserExecutable } from "./browser-executable.mjs";
import { VISUAL_CWD, VISUAL_SESSION } from "../tests/visual/fixtures/data.mjs";

const frontendRoot = new URL("..", import.meta.url);
const cwd = decodeURIComponent(VISUAL_CWD);
const port = Number(process.env.PI_SCIENCE_SSE_BUDGET_PORT || 4174);
const origin = `http://127.0.0.1:${port}`;
const sessionEndpoint = `/api/sessions/${VISUAL_SESSION}/events`;
const executionEndpoint = "/api/executions/events";
const knowledgeEndpoint = "/api/project-knowledge/events";
/** The session page's necessary subscriptions: its own conversation stream plus
 *  the workspace-wide project-knowledge signal. Anything else is over budget. */
const SESSION_PAGE_BUDGET = [sessionEndpoint, knowledgeEndpoint];
/** The executions page reads runs over REST, so it needs the lossy invalidation
 *  signal for that cache and the same workspace-wide signal as every route. */
const RUNS_PAGE_BUDGET = [executionEndpoint, knowledgeEndpoint];
const server = spawn(process.execPath, ["tests/visual/fixtures/mock-server.mjs"], {
  cwd: frontendRoot,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});
/** The child prints this only after its own listen() callback, so it proves this
 *  child owns the port. A health probe before it lands can be answered by a
 *  leftover fixture server on the same port, and the budget would then be
 *  measured against the wrong dist/ instead of the build under test. */
let serverListening = false;
server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (chunk.includes("visual fixture server on http://127.0.0.1:")) serverListening = true;
});
let browser;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Fixture server exited with ${server.exitCode}`);
    if (serverListening) {
      try {
        const response = await fetch(`${origin}/api/health`);
        if (response.ok) return;
      } catch { /* the fixture server is still starting */ }
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the fixture server health check");
}

async function installSourceTracker(context) {
  await context.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    const sources = [];
    window.__sseBudget = { sources };
    window.__sseBudgetHidden = false;
    class TrackedEventSource extends NativeEventSource {
      constructor(url, options) {
        super(url, options);
        const record = { url: String(url), opened: false, closed: false };
        sources.push(record);
        this.addEventListener("open", () => { record.opened = true; });
        const close = this.close.bind(this);
        this.close = () => { record.closed = true; close(); };
      }
    }
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      writable: true,
      value: TrackedEventSource,
    });
    // Drive the browser's real visibilitychange listeners deterministically;
    // the native EventSource remains real and its sockets are observed below.
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => window.__sseBudgetHidden,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => window.__sseBudgetHidden ? "hidden" : "visible",
    });
  });
}

async function setHidden(page, hidden) {
  await page.evaluate((value) => {
    window.__sseBudgetHidden = value;
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

async function sources(page) {
  return page.evaluate(() => window.__sseBudget.sources.map((source) => ({ ...source })));
}

async function waitForOpenSource(page, endpoint, count = 1) {
  await page.waitForFunction(({ needle, expected }) => window.__sseBudget.sources
    .filter((source) => !source.closed && source.opened && source.url.includes(needle)).length === expected,
  { needle: endpoint, expected: count }, { timeout: 20_000 });
}

async function activeSourceCount(page, endpoint) {
  return page.evaluate((needle) => window.__sseBudget.sources
    .filter((source) => !source.closed && source.url.includes(needle)).length, endpoint);
}

/** Every budgeted stream must be released in the background, not only the one a
 *  scenario names, so wait for the whole page to reach zero before asserting. */
async function waitForNoActiveSources(page, label) {
  try {
    await page.waitForFunction(() => window.__sseBudget.sources.every((source) => source.closed), null, { timeout: 20_000 });
  } catch {
    const active = await activeSourcePaths(page);
    throw new Error(`${label}: SSE subscriptions still open in the background: ${active.join(", ")}`);
  }
}

/** Endpoint paths of every active EventSource, so a violation names the stream
 *  instead of only its count. */
async function activeSourcePaths(page) {
  return page.evaluate(() => window.__sseBudget.sources
    .filter((source) => !source.closed)
    .map((source) => {
      try { return new URL(source.url, window.location.origin).pathname; } catch { return source.url; }
    }));
}

function describeStreams(paths) {
  const counts = new Map();
  for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
  if (counts.size === 0) return "none";
  return [...counts].map(([path, count]) => count > 1 ? `${path} x${count}` : path).join(", ");
}

/** Counting a single endpoint would let a second subscription come back
 *  unnoticed, so the whole page is compared against its known budget as a
 *  multiset. */
async function assertStreamBudget(page, label, allowed) {
  const active = (await activeSourcePaths(page)).sort();
  const budget = [...allowed].sort();
  const balanced = active.length === budget.length && active.every((path, index) => path === budget[index]);
  assert(balanced, `${label}: SSE subscriptions are ${describeStreams(active)}, budgeted ${describeStreams(budget)}`);
}

async function openSession(page) {
  await page.goto(`${origin}/workspace/${encodeURIComponent(cwd)}/session/${VISUAL_SESSION}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Shikimate pathway analysis" }).waitFor({ timeout: 30_000 });
}

try {
  await access(new URL("../dist/index.html", import.meta.url));
  await waitForHealth();
  const executablePath = await resolveBrowserExecutable();
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 1000 } });
  await installSourceTracker(context);

  // Hold the first conversation response so the tab is hidden while its first
  // EventSource is still CONNECTING, then verify resumed catch-up uses the
  // recovery sentinel and leaves exactly one active connection.
  const firstPage = await context.newPage();
  let releaseFirstRequest;
  const firstRequestGate = new Promise((resolve) => { releaseFirstRequest = resolve; });
  let requestCount = 0;
  const sessionRoute = `**${sessionEndpoint}**`;
  await firstPage.route(sessionRoute, async (route) => {
    requestCount += 1;
    if (requestCount === 1) await firstRequestGate;
    try { await route.continue(); } catch { /* the hidden source may abort its request */ }
  });
  await openSession(firstPage);
  await firstPage.waitForFunction((needle) => window.__sseBudget.sources.some((source) => source.url.includes(needle)), sessionEndpoint);
  const initialSource = (await sources(firstPage)).find((source) => source.url.includes(sessionEndpoint));
  assert(initialSource && !initialSource.opened, "The first conversation stream should still be CONNECTING in this case");
  await setHidden(firstPage, true);
  await waitForNoActiveSources(firstPage, "The session page while hidden");
  await assertStreamBudget(firstPage, "The session page while hidden", []);
  releaseFirstRequest();
  await firstPage.unroute(sessionRoute);
  await setHidden(firstPage, false);
  await waitForOpenSource(firstPage, sessionEndpoint);
  let firstPageSources = await sources(firstPage);
  let resumedSource = firstPageSources.findLast((source) => source.url.includes(sessionEndpoint));
  assert(resumedSource?.url.includes("lastEventId=pi-recovery-sentinel%3A0"), "A resume without an applied cursor must request the recovery sentinel");
  assert(await activeSourceCount(firstPage, sessionEndpoint) === 1, "Resuming the first connection must leave one conversation SSE");
  await assertStreamBudget(firstPage, "After resuming the first connection", SESSION_PAGE_BUDGET);

  // Two visible tabs keep one necessary conversation stream each. Hiding one
  // must release only that tab's stream; showing it again must restore one.
  const secondPage = await context.newPage();
  await openSession(secondPage);
  await waitForOpenSource(secondPage, sessionEndpoint);
  assert(await activeSourceCount(firstPage, sessionEndpoint) === 1, "The first visible tab must retain one stream");
  assert(await activeSourceCount(secondPage, sessionEndpoint) === 1, "The second visible tab must retain one stream");
  await assertStreamBudget(secondPage, "With two visible session tabs", SESSION_PAGE_BUDGET);
  await setHidden(firstPage, true);
  await waitForNoActiveSources(firstPage, "The hidden tab while the other tab stays visible");
  await assertStreamBudget(firstPage, "The hidden tab while the other tab stays visible", []);
  assert(await activeSourceCount(secondPage, sessionEndpoint) === 1, "Hiding one tab must not close the other tab's stream");
  await setHidden(firstPage, false);
  await waitForOpenSource(firstPage, sessionEndpoint);
  assert(await activeSourceCount(firstPage, sessionEndpoint) === 1, "Showing the tab again must leave one stream");
  await assertStreamBudget(firstPage, "After showing the tab again", SESSION_PAGE_BUDGET);

  await firstPage.reload({ waitUntil: "domcontentloaded" });
  await firstPage.getByRole("heading", { name: "Shikimate pathway analysis" }).waitFor({ timeout: 30_000 });
  await waitForOpenSource(firstPage, sessionEndpoint);
  assert(await activeSourceCount(firstPage, sessionEndpoint) === 1, "A document reload must restore one conversation stream");
  await assertStreamBudget(firstPage, "After a document reload", SESSION_PAGE_BUDGET);

  // The executions page uses a REST invalidation stream. Exercise its hidden
  // and resume path in a real browser, including the initial delayed OPEN edge.
  const runsPage = await context.newPage();
  await runsPage.goto(`${origin}/workspace/${encodeURIComponent(cwd)}/runs`, { waitUntil: "domcontentloaded" });
  await runsPage.getByRole("heading", { name: "Executions" }).waitFor({ timeout: 30_000 });
  await waitForOpenSource(runsPage, executionEndpoint);
  assert(await activeSourceCount(runsPage, executionEndpoint) === 1, "The executions page must hold one invalidation SSE");
  await assertStreamBudget(runsPage, "The executions page", RUNS_PAGE_BUDGET);
  await setHidden(runsPage, true);
  await waitForNoActiveSources(runsPage, "The executions page while hidden");
  await assertStreamBudget(runsPage, "The executions page while hidden", []);
  await setHidden(runsPage, false);
  await waitForOpenSource(runsPage, executionEndpoint);
  assert(await activeSourceCount(runsPage, executionEndpoint) === 1, "Resuming executions must leave one invalidation SSE");
  await assertStreamBudget(runsPage, "Resuming executions", RUNS_PAGE_BUDGET);

  // These three tabs already consume six HTTP/1.1 SSE sockets. Release them
  // before opening independent scenarios on the same fixture origin.
  console.log(`Observed session-page streams: ${(await activeSourcePaths(firstPage)).join(", ")}`);
  console.log(`Observed executions-page streams: ${(await activeSourcePaths(runsPage)).join(", ")}`);
  await firstPage.close();
  await secondPage.close();
  await runsPage.close();


  // A knowledge badge must use the REST count after a hidden interval.
  const knowledgePage = await context.newPage();
  let pendingCount = 1;
  await knowledgePage.route("**/api/project-knowledge/proposals/count**", (route) =>
    route.fulfill({ json: { pending_count: pendingCount } }));
  await openSession(knowledgePage);
  const badge = knowledgePage.getByRole("button", { name: /Project Knowledge/ });
  await badge.getByText("1", { exact: true }).waitFor();
  await setHidden(knowledgePage, true);
  await waitForNoActiveSources(knowledgePage, "Knowledge hidden");
  pendingCount = 2;
  await setHidden(knowledgePage, false);
  await badge.getByText("2", { exact: true }).waitFor();
  await waitForOpenSource(knowledgePage, knowledgeEndpoint);
  await assertStreamBudget(knowledgePage, "Knowledge catch-up", SESSION_PAGE_BUDGET);
  await knowledgePage.close();

  // Runs and its Notebook inspector must share the execution signal.
  const notebookPage = await context.newPage();
  let notebookOutput = "initial notebook output";
  let kernelStatus = "succeeded";
  const kernelExecution = () => ({
    schema_version: 1, execution_id: "budget-kernel", kind: "kernel_cell",
    surface: "python", status: kernelStatus, workspace_id: cwd,
    created_at: "2026-09-24T00:00:00Z", started_at: "2026-09-24T00:00:00Z",
    ended_at: "2026-09-24T00:00:01Z", producer: "node-kernel-gateway",
    correlation: { request_id: "budget-request", session_id: VISUAL_SESSION },
    request: { notebook_id: `session-${VISUAL_SESSION}`, code: "print('fixture')",
      language: "python", source: "session_notebook" },
    runtime: { cwd, gateway_timeout_ms: 125000 },
    result: { stdout_preview: notebookOutput }, files: { read: [], written: [] }, artifacts: [],
  });
  await notebookPage.route("**/api/executions?**", (route) => route.fulfill({ json: { executions: [kernelExecution()] } }));
  await notebookPage.goto(`${origin}/workspace/${encodeURIComponent(cwd)}/session/${VISUAL_SESSION}?view=runs`, { waitUntil: "domcontentloaded" });
  await notebookPage.getByRole("button", { name: "Open session kernel", exact: true }).click();
  await notebookPage.getByRole("button", { name: /Close notebook/i }).waitFor();
  await notebookPage.getByText(notebookOutput, { exact: true }).waitFor();
  await waitForOpenSource(notebookPage, executionEndpoint);
  const notebookBudget = [...SESSION_PAGE_BUDGET, executionEndpoint];
  await assertStreamBudget(notebookPage, "Runs plus Notebook", notebookBudget);
  await setHidden(notebookPage, true);
  await waitForNoActiveSources(notebookPage, "Notebook hidden");
  notebookOutput = "restored notebook output";
  kernelStatus = "running";
  let releaseExecutionRequest;
  const executionGate = new Promise((resolve) => { releaseExecutionRequest = resolve; });
  const executionRoute = `**${executionEndpoint}**`;
  await notebookPage.route(executionRoute, async (route) => {
    await executionGate;
    try { await route.continue(); } catch { /* navigation can abort the held request */ }
  });
  await setHidden(notebookPage, false);
  await notebookPage.getByText(notebookOutput, { exact: true }).waitFor();
  const connectingSource = (await sources(notebookPage)).findLast((source) => source.url.includes(executionEndpoint));
  assert(connectingSource && !connectingSource.opened, "The restored execution stream must still be CONNECTING");
  notebookOutput = "polled notebook output";
  await notebookPage.getByText(notebookOutput, { exact: true }).waitFor({ timeout: 15_000 });
  assert(!(await sources(notebookPage)).findLast((source) => source.url.includes(executionEndpoint))?.opened,
    "REST fallback must update Notebook before execution SSE reaches OPEN");
  releaseExecutionRequest();
  await notebookPage.unroute(executionRoute);
  await waitForOpenSource(notebookPage, executionEndpoint);
  await assertStreamBudget(notebookPage, "Notebook catch-up", notebookBudget);
  await notebookPage.getByRole("button", { name: /Close notebook/i }).click();
  await assertStreamBudget(notebookPage, "Notebook cleanup keeps Runs subscribed", notebookBudget);
  await openSession(notebookPage);
  await waitForOpenSource(notebookPage, sessionEndpoint);
  await assertStreamBudget(notebookPage, "Leaving Runs releases execution SSE", SESSION_PAGE_BUDGET);
  await notebookPage.close();

  // Research list and detail must both recover authoritative REST data.
  const researchPage = await context.newPage();
  let researchTitle = "Budget research";
  let revision = 1;
  const loop = () => ({ loop_id: "budget-loop", title: researchTitle,
    objective: "Verify visibility recovery", task_type: "research_loop", status: "running",
    revision, candidates: [], operations: [] });
  await researchPage.route("**/api/project-memory/research-loops**", (route) =>
    route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/research-loops")
      ? { loops: [loop()] } : loop() }));
  await researchPage.goto(`${origin}/workspace/${encodeURIComponent(cwd)}/research`, { waitUntil: "domcontentloaded" });
  const researchEndpoint = "/api/project-memory/research-events";
  await researchPage.getByRole("heading", { name: researchTitle, exact: true }).waitFor();
  await waitForOpenSource(researchPage, researchEndpoint);
  await assertStreamBudget(researchPage, "Research", [knowledgeEndpoint, researchEndpoint]);
  await setHidden(researchPage, true);
  await waitForNoActiveSources(researchPage, "Research hidden");
  researchTitle = "Recovered research"; revision += 1;
  await setHidden(researchPage, false);
  await researchPage.getByRole("heading", { name: researchTitle, exact: true }).waitFor();
  await waitForOpenSource(researchPage, researchEndpoint);
  await assertStreamBudget(researchPage, "Research catch-up", [knowledgeEndpoint, researchEndpoint]);
  await researchPage.goto(`${origin}/workspace/${encodeURIComponent(cwd)}/runs`, { waitUntil: "domcontentloaded" });
  await waitForOpenSource(researchPage, executionEndpoint);
  await assertStreamBudget(researchPage, "Research cleanup", RUNS_PAGE_BUDGET);
  await researchPage.close();

  const health = await fetch(`${origin}/api/health`);
  assert(health.ok, `/api/health returned ${health.status}`);
  console.log("SSE connection budget passed: per-page subscription sets, two visible tabs, hidden-tab release, first CONNECTING resume, reload, executions resume, Knowledge count, shared Notebook stream, Research detail, and /api/health.");
  await context.close();
} finally {
  // A rejected close must never skip the SIGTERM: a leftover fixture server
  // would answer the next run's health probe on the same fixed port.
  try {
    await browser?.close();
  } finally {
    server.kill("SIGTERM");
  }
}
