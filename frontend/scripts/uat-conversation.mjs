import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveBrowserExecutable } from "./browser-executable.mjs";


const frontend = process.env.PI_SCIENCE_FRONTEND_URL || "http://127.0.0.1:5173";
const backend = process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787";
const chromePath = await resolveBrowserExecutable();
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

    // Session creation is LAZY: a fresh workspace landing never carries a
    // /session/ URL. The first prompt creates the server-side session and
    // replaces the URL. Clicking "New conversation" only returns to this
    // landing; it must not create a session by itself.
    if (/\/session\//.test(page.url())) {
      throw new Error("A fresh workspace landing must not open a session route");
    }
    const composer = page.getByPlaceholder(/Ask anything/);
    await composer.waitFor({ timeout: 20_000 });

    // The composer model control is a Radix dropdown, not a native <select>.
    // The trigger keeps one stable accessible name; the selected model shows
    // its display name inside the open Model submenu next to a check icon.
    const modelTrigger = page.getByRole("button", { name: "Select model and thinking level and view context" });
    const configuredModel = Array.isArray(config.available_models)
      ? config.available_models.find((item) => item.id === config.model)
      : null;
    const expectedModelLabel = configuredModel?.model ?? config.model;
    const hasConfiguredModel = typeof config.model === "string" && config.model.length > 0 && configuredModel !== null;

    let firstSession = null;
    if (hasConfiguredModel) {
      await modelTrigger.waitFor({ timeout: 20_000 });
      await modelTrigger.click();
      await page.getByRole("menuitem", { name: /^Model/ }).click();
      const modelItems = page.getByRole("menuitem");
      const checkedModel = modelItems.filter({ has: page.locator(".lucide-check") });
      await checkedModel.first().waitFor({ timeout: 10_000 });
      const selectedLabel = (await checkedModel.first().textContent())?.trim();
      if (selectedLabel !== expectedModelLabel) {
        throw new Error(`Composer selected ${JSON.stringify(selectedLabel)} instead of ${JSON.stringify(expectedModelLabel)}`);
      }
      await page.keyboard.press("Escape");

      await composer.fill("请先使用 bash 工具执行 sleep 2，然后只回复 CHAT_BROWSER_UAT_OK");
      await page.getByRole("button", { name: "Send message" }).click();
      // The first prompt lazily creates the session and lands on /session/:id.
      await page.waitForURL(/\/session\//, { timeout: 30_000 });
      firstSession = sessionIdFromUrl(page.url());
      if (!firstSession) throw new Error(`No session ID after the first prompt: ${page.url()}`);
      createdSessions.push(firstSession);
      await page.getByRole("button", { name: "Stop generation" }).waitFor({ timeout: 10_000 });
      await page.getByText("Working…", { exact: true }).first().waitFor({ timeout: 10_000 });
      await page.getByText("CHAT_BROWSER_UAT_OK", { exact: true }).waitFor({ timeout: 120_000 });
      await page.getByRole("button", { name: "Send message" }).waitFor({ timeout: 20_000 });
    } else {
      if (await modelTrigger.count()) throw new Error("Model selector should be hidden when no models are available");
      await composer.fill("model configuration required");
      if (!(await page.getByRole("button", { name: "Send message" }).isDisabled())) {
        throw new Error("Send should be disabled when no provider/model is configured");
      }
      await composer.fill("");
    }

    // New conversation returns to the blank landing. With lazy creation there
    // is no session in the URL until the next prompt is sent.
    await page.getByTitle("New conversation").click();
    await page.waitForFunction(() => !/\/session\//.test(window.location.pathname), undefined, { timeout: 20_000 });
    if (sessionIdFromUrl(page.url())) {
      throw new Error("New conversation should land on the blank landing, not a session route");
    }
    await page.screenshot({ path: screenshot, fullPage: true });

    let secondSession = null;
    if (hasConfiguredModel) {
      await modelTrigger.waitFor({ timeout: 20_000 });
      await composer.fill("second lazy session prompt");
      await page.getByRole("button", { name: "Send message" }).click();
      await page.waitForURL(/\/session\//, { timeout: 30_000 });
      secondSession = sessionIdFromUrl(page.url());
      if (!secondSession || secondSession === firstSession) {
        throw new Error(`New conversation reused the old ID: ${firstSession}`);
      }
      createdSessions.push(secondSession);
    } else {
      console.log("SKIP second-session ID check: creating a session requires a configured model");
    }

    const observedSessions = await Promise.all(sessionRuntimeChecks);
    if (hasConfiguredModel) {
      if (!observedSessions.length) throw new Error("Browser did not make any session API requests");
      const wrongOwner = observedSessions.find((item) => item.runtime !== "node-control-plane");
      if (wrongOwner) throw new Error(`Session request escaped Node ownership: ${JSON.stringify(wrongOwner)}`);
      if (!observedSessions.some((item) => item.method === "POST" && item.path === "/api/sessions")) {
        throw new Error("Browser did not create a session through the Node API");
      }
      if (!observedSessions.some((item) => item.method === "POST" && item.path.endsWith("/prompt"))) {
        throw new Error("Browser did not send its prompt through the Node API");
      }
      const eventStream = observedSessions.find((item) => item.path.endsWith("/events"));
      if (!eventStream) throw new Error("Browser did not connect to the session SSE endpoint");
      if (eventStream.sse !== "node-native") {
        throw new Error(`Expected node-native SSE, got ${eventStream.sse || "missing header"}`);
      }
    } else {
      console.log("SKIP session ownership checks: no session is created without a configured model");
    }
    if (runtimeErrors.length) throw new Error(`Browser runtime errors:\n${runtimeErrors.join("\n")}`);
    console.log("PASS workspace marker accepted by Node workspace security");
    if (hasConfiguredModel) {
      console.log(`PASS composer selected configured model ${config.model}`);
      console.log("PASS first prompt lazily created the session and the URL moved to /session/:id");
      console.log("PASS send immediately showed stop/working state and settled with streamed text");
      console.log("PASS browser session create/prompt/SSE responses were owned by node-control-plane");
      console.log("PASS browser SSE response reported node-native");
      console.log(`PASS new conversation changed ID ${firstSession} -> ${secondSession}`);
    } else {
      console.log("PASS composer clearly disabled sending because no provider/model is configured");
      console.log("SKIP browser prompt: configure a model to run the streamed-text branch (covered by smoke:real-pi)");
    }
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
