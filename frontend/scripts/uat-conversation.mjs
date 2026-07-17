import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";


const frontend = process.env.PI_SCIENCE_FRONTEND_URL || "http://127.0.0.1:5173";
const backend = process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787";
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const workspace = path.join(os.tmpdir(), `pi-science-conversation-uat-${process.pid}`);
const screenshot = path.join(os.tmpdir(), "pi-science-conversation-uat.png");


async function api(endpoint, init) {
  const response = await fetch(`${backend}${endpoint}`, init);
  if (!response.ok) throw new Error(`${endpoint}: ${response.status} ${await response.text()}`);
  return response.json();
}


function sessionIdFromUrl(url) {
  const match = /\/session\/([^/?#]+)/.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}


async function run() {
  await mkdir(workspace, { recursive: true });
  const config = await api("/api/settings/config");
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const runtimeErrors = [];
  const createdSessions = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  try {
    const route = `/workspace/${encodeURIComponent(workspace)}`;
    await page.goto(`${frontend}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/session\//, { timeout: 20_000 });
    const firstSession = sessionIdFromUrl(page.url());
    if (!firstSession) throw new Error(`No session ID after connect: ${page.url()}`);
    createdSessions.push(firstSession);

    const modelSelect = page.getByLabel("Select model");
    await modelSelect.waitFor();
    await page.waitForFunction(() => {
      const select = document.querySelector('select[aria-label="Select model"]');
      return select instanceof HTMLSelectElement && !select.disabled;
    });
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

    await page.getByTitle("New session").click();
    await page.waitForFunction((previous) => !window.location.pathname.endsWith(`/session/${previous}`), firstSession);
    const secondSession = sessionIdFromUrl(page.url());
    if (!secondSession || secondSession === firstSession) {
      throw new Error(`New conversation reused the old ID: ${firstSession}`);
    }
    createdSessions.push(secondSession);
    await page.waitForFunction(() => {
      const select = document.querySelector('select[aria-label="Select model"]');
      return select instanceof HTMLSelectElement && !select.disabled;
    });
    if (await modelSelect.inputValue() !== config.model) {
      throw new Error("New conversation did not inherit the configured model");
    }
    await page.screenshot({ path: screenshot, fullPage: true });

    if (runtimeErrors.length) throw new Error(`Browser runtime errors:\n${runtimeErrors.join("\n")}`);
    console.log(`PASS composer selected configured model ${config.model}`);
    console.log("PASS send immediately showed stop/working state and settled with streamed text");
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
