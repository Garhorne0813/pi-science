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
const server = spawn(process.execPath, ["tests/visual/fixtures/mock-server.mjs"], {
  cwd: frontendRoot,
  env: { ...process.env, PORT: String(port) },
  stdio: "inherit",
});
let browser;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Fixture server exited with ${server.exitCode}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch { /* the fixture server is still starting */ }
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
  await firstPage.waitForFunction((needle) => window.__sseBudget.sources.some((source) => source.url.includes(needle) && source.closed), sessionEndpoint);
  releaseFirstRequest();
  await firstPage.unroute(sessionRoute);
  await setHidden(firstPage, false);
  await waitForOpenSource(firstPage, sessionEndpoint);
  let firstPageSources = await sources(firstPage);
  let resumedSource = firstPageSources.findLast((source) => source.url.includes(sessionEndpoint));
  assert(resumedSource?.url.includes("lastEventId=pi-recovery-sentinel%3A0"), "A resume without an applied cursor must request the recovery sentinel");
  assert(await activeSourceCount(firstPage, sessionEndpoint) === 1, "Resuming the first connection must leave one conversation SSE");

  // Two visible tabs keep one necessary conversation stream each. Hiding one
  // must release only that tab's stream; showing it again must restore one.
  const secondPage = await context.newPage();
  await openSession(secondPage);
  await waitForOpenSource(secondPage, sessionEndpoint);
  assert(await activeSourceCount(firstPage, sessionEndpoint) === 1, "The first visible tab must retain one stream");
  assert(await activeSourceCount(secondPage, sessionEndpoint) === 1, "The second visible tab must retain one stream");
  await setHidden(firstPage, true);
  await firstPage.waitForFunction((needle) => window.__sseBudget.sources.filter((source) => !source.closed && source.url.includes(needle)).length === 0, sessionEndpoint);
  assert(await activeSourceCount(secondPage, sessionEndpoint) === 1, "Hiding one tab must not close the other tab's stream");
  await setHidden(firstPage, false);
  await waitForOpenSource(firstPage, sessionEndpoint);
  assert(await activeSourceCount(firstPage, sessionEndpoint) === 1, "Showing the tab again must leave one stream");

  await firstPage.reload({ waitUntil: "domcontentloaded" });
  await firstPage.getByRole("heading", { name: "Shikimate pathway analysis" }).waitFor({ timeout: 30_000 });
  await waitForOpenSource(firstPage, sessionEndpoint);
  assert(await activeSourceCount(firstPage, sessionEndpoint) === 1, "A document reload must restore one conversation stream");

  // The executions page uses a REST invalidation stream. Exercise its hidden
  // and resume path in a real browser, including the initial delayed OPEN edge.
  const runsPage = await context.newPage();
  const executionEndpoint = "/api/executions/events";
  await runsPage.goto(`${origin}/workspace/${encodeURIComponent(cwd)}/runs`, { waitUntil: "domcontentloaded" });
  await runsPage.getByRole("heading", { name: "Executions" }).waitFor({ timeout: 30_000 });
  await waitForOpenSource(runsPage, executionEndpoint);
  assert(await activeSourceCount(runsPage, executionEndpoint) === 1, "The executions page must hold one invalidation SSE");
  await setHidden(runsPage, true);
  await runsPage.waitForFunction((needle) => window.__sseBudget.sources.filter((source) => !source.closed && source.url.includes(needle)).length === 0, executionEndpoint);
  await setHidden(runsPage, false);
  await waitForOpenSource(runsPage, executionEndpoint);
  assert(await activeSourceCount(runsPage, executionEndpoint) === 1, "Resuming executions must leave one invalidation SSE");

  const health = await fetch(`${origin}/api/health`);
  assert(health.ok, `/api/health returned ${health.status}`);
  console.log("SSE connection budget passed: two visible tabs, hidden-tab release, first CONNECTING resume, reload, executions resume, and /api/health.");
  await context.close();
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
