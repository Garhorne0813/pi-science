import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";


const frontend = process.env.PI_SCIENCE_FRONTEND_URL || "http://127.0.0.1:5173";
const backend = process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787";
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const workspace = path.join(os.tmpdir(), `pi-science-conversation-uat-${process.pid}`);
const screenshot = path.join(os.tmpdir(), "pi-science-conversation-uat.png");
const browserApiOrigins = new Set([new URL(frontend).origin, new URL(backend).origin]);


async function api(endpoint, init, expectedRuntime = "node-control-plane") {
  const response = await fetch(`${backend}${endpoint}`, init);
  if (!response.ok) throw new Error(`${endpoint}: ${response.status} ${await response.text()}`);
  const runtime = response.headers.get("x-pi-science-runtime");
  if (expectedRuntime && runtime !== expectedRuntime) {
    throw new Error(`${endpoint}: expected ${expectedRuntime} runtime, got ${runtime || "missing header"}`);
  }
  return response.json();
}


function sessionIdFromUrl(url) {
  const match = /\/session\/([^/?#]+)/.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}


async function run() {
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(workspace, ".pi-science"), { recursive: true });
  await api("/api/health");
  const config = await api("/api/settings/config");
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 1000 } });
  const runtimeErrors = [];
  const createdSessions = [];
  const sessionRuntimeChecks = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!browserApiOrigins.has(url.origin) || !url.pathname.startsWith("/api/sessions")) return;
    sessionRuntimeChecks.push((async () => ({
      method: response.request().method(),
      path: url.pathname,
      runtime: await response.headerValue("x-pi-science-runtime"),
      sse: await response.headerValue("x-pi-science-sse"),
    }))());
  });
  try {
    const route = `/workspace/${encodeURIComponent(workspace)}`;
    await page.goto(`${frontend}${route}`, { waitUntil: "domcontentloaded" });
    // A fresh workspace intentionally opens with a blank composer. Create the
    // first persisted session explicitly before asserting the session route.
    if (!/\/session\//.test(page.url())) {
      await page.getByTitle("New conversation").click();
    }
    await page.waitForURL(/\/session\//, { timeout: 20_000 });
    const firstSession = sessionIdFromUrl(page.url());
    if (!firstSession) throw new Error(`No session ID after connect: ${page.url()}`);
    createdSessions.push(firstSession);

    const modelSelect = page.getByLabel("Select model");
    const hasConfiguredModel = typeof config.model === "string" && config.model.length > 0;
    if (hasConfiguredModel) {
      await modelSelect.waitFor({ timeout: 20_000 });
      await page.waitForFunction(() => {
        const select = document.querySelector('select[aria-label="Select model"]');
        return select instanceof HTMLSelectElement && !select.disabled;
      }, undefined, { timeout: 20_000 });
      if (await modelSelect.inputValue() !== config.model) {
        throw new Error(`Composer selected ${await modelSelect.inputValue()} instead of ${config.model}`);
      }
      const options = await modelSelect.locator("option").evaluateAll((nodes) => nodes.map((node) => node.value));
      if (!options.includes(config.model)) throw new Error(`Configured custom model is not selectable: ${config.model}`);

      const composer = page.getByPlaceholder(/Ask anything/);
      await composer.fill("请先使用 bash 工具执行 sleep 2，然后只回复 CHAT_BROWSER_UAT_OK");
      await page.getByRole("button", { name: "Send message" }).click();
      await page.getByRole("button", { name: "Stop generation" }).waitFor({ timeout: 10_000 });
      await page.getByText("Working…", { exact: true }).waitFor({ timeout: 10_000 });
      await page.getByText("CHAT_BROWSER_UAT_OK", { exact: true }).waitFor({ timeout: 120_000 });
      await page.getByRole("button", { name: "Send message" }).waitFor({ timeout: 20_000 });
    } else {
      if (await modelSelect.count()) throw new Error("Model selector should be hidden when no models are available");
      const composer = page.getByPlaceholder(/Ask anything/);
      await composer.fill("model configuration required");
      if (!(await page.getByRole("button", { name: "Send message" }).isDisabled())) {
        throw new Error("Send should be disabled when no provider/model is configured");
      }
      await composer.fill("");
    }

    await page.getByTitle("New conversation").click();
    await page.waitForFunction((previous) => !window.location.pathname.endsWith(`/session/${previous}`), firstSession);
    const secondSession = sessionIdFromUrl(page.url());
    if (!secondSession || secondSession === firstSession) {
      throw new Error(`New conversation reused the old ID: ${firstSession}`);
    }
    createdSessions.push(secondSession);
    if (hasConfiguredModel) {
      await page.waitForFunction(() => {
        const select = document.querySelector('select[aria-label="Select model"]');
        return select instanceof HTMLSelectElement && !select.disabled;
      }, undefined, { timeout: 20_000 });
      if (await modelSelect.inputValue() !== config.model) {
        throw new Error("New conversation did not inherit the configured model");
      }
    }
    await page.screenshot({ path: screenshot, fullPage: true });

    const observedSessions = await Promise.all(sessionRuntimeChecks);
    if (!observedSessions.length) throw new Error("Browser did not make any session API requests");
    const wrongOwner = observedSessions.find((item) => item.runtime !== "node-control-plane");
    if (wrongOwner) throw new Error(`Session request escaped Node ownership: ${JSON.stringify(wrongOwner)}`);
    if (!observedSessions.some((item) => item.method === "POST" && item.path === "/api/sessions")) {
      throw new Error("Browser did not create a session through the Node API");
    }
    if (hasConfiguredModel && !observedSessions.some((item) => item.method === "POST" && item.path.endsWith("/prompt"))) {
      throw new Error("Browser did not send its prompt through the Node API");
    }
    const eventStream = observedSessions.find((item) => item.path.endsWith("/events"));
    if (!eventStream) throw new Error("Browser did not connect to the session SSE endpoint");
    if (eventStream.sse !== "node-native") {
      throw new Error(`Expected node-native SSE, got ${eventStream.sse || "missing header"}`);
    }
    if (runtimeErrors.length) throw new Error(`Browser runtime errors:\n${runtimeErrors.join("\n")}`);
    console.log("PASS workspace marker accepted by Node workspace security");
    console.log("PASS browser session create/prompt/SSE responses were owned by node-control-plane");
    console.log("PASS browser SSE response reported node-native");
    if (hasConfiguredModel) {
      console.log(`PASS composer selected configured model ${config.model}`);
      console.log("PASS send immediately showed stop/working state and settled with streamed text");
    } else {
      console.log("PASS composer clearly disabled sending because no provider/model is configured");
      console.log("SKIP browser prompt: configure a model to run the streamed-text branch (covered by smoke:real-pi)");
    }
    console.log(`PASS new conversation changed ID ${firstSession} -> ${secondSession}`);
    console.log(`SCREENSHOT ${screenshot}`);
  } finally {
    await browser.close();
    for (const sessionId of createdSessions) {
      const query = new URLSearchParams({ cwd: workspace });
      await fetch(`${backend}/api/sessions/${encodeURIComponent(sessionId)}?${query}`, {
        method: "DELETE",
      }).catch(() => undefined);
    }
    await rm(workspace, { recursive: true, force: true });
  }
}


run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
