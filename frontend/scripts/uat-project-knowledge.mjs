import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";


const frontend = process.env.PI_SCIENCE_FRONTEND_URL || "http://127.0.0.1:5173";
const backend = process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787";
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const workspace = path.join(os.tmpdir(), `pi-science-knowledge-uat-${process.pid}`);
const desktopScreenshot = path.join(os.tmpdir(), "pi-science-knowledge-uat-desktop.png");
const mobileScreenshot = path.join(os.tmpdir(), "pi-science-knowledge-uat-mobile.png");


async function api(endpoint, init) {
  const response = await fetch(`${backend}${endpoint}`, init);
  if (!response.ok) throw new Error(`${endpoint}: ${response.status} ${await response.text()}`);
  return response.json();
}


async function waitForPath(filePath, exists) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await access(filePath);
      if (exists) return;
    } catch {
      if (!exists) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${filePath} to ${exists ? "exist" : "disappear"}`);
}


async function seedWorkspace() {
  await mkdir(workspace, { recursive: true });
  await api(`/api/project-knowledge/initialize?cwd=${encodeURIComponent(workspace)}`, { method: "POST" });
  await writeFile(path.join(workspace, "result.csv"), "condition,value\nA,12.4\nB,14.1\n");
  const proposals = [
    {
      proposal_type: "knowledge",
      knowledge_type: "decision",
      title: "Use Reviewer approval before project updates",
      summary: "Reviewer suggestions stay in the inbox until the user accepts, edits, or rejects them.",
      reason: "The user explicitly selected a human-confirmed update workflow.",
      confidence: "high",
      importance: "important",
      source_message_ids: ["uat-message-1"],
      related_files: [],
      conflicts_with: [],
      supersedes: [],
      operations: [],
      id: "proposal-uat-knowledge",
      status: "pending",
      source: { session_id: null, message_ids: ["uat-message-1"], files: [], run_ids: [], citations: [] },
      fingerprint: "uat-knowledge",
      reviewer_run_id: "review-uat",
      created_at: "2026-07-15T02:55:00+08:00",
      updated_at: "2026-07-15T02:55:00+08:00",
      decision_reason: null,
      applied_history_id: null,
    },
    {
      proposal_type: "file_operation",
      knowledge_type: null,
      title: "Move result into processed data",
      summary: "Organize the generated result under the stable data/processed category.",
      reason: "The CSV is a processed result and the target directory follows the project skeleton.",
      confidence: "high",
      importance: "normal",
      source_message_ids: [],
      related_files: ["result.csv"],
      conflicts_with: [],
      supersedes: [],
      operations: [{ type: "move", source: "result.csv", target: "data/processed/result.csv", reason: "Stable processed-data category" }],
      id: "proposal-uat-file",
      status: "pending",
      source: { session_id: null, message_ids: [], files: ["result.csv"], run_ids: [], citations: [] },
      fingerprint: "uat-file",
      reviewer_run_id: "review-uat",
      created_at: "2026-07-15T02:56:00+08:00",
      updated_at: "2026-07-15T02:56:00+08:00",
      decision_reason: null,
      applied_history_id: null,
    },
  ];
  await mkdir(path.join(workspace, ".pi-science", "inbox"), { recursive: true });
  await writeFile(path.join(workspace, ".pi-science", "inbox", "proposals.json"), `${JSON.stringify(proposals, null, 2)}\n`);
}


async function run() {
  await seedWorkspace();
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  try {
    const route = `/workspace/${encodeURIComponent(workspace)}/knowledge`;
    await page.goto(`${frontend}${route}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Project Knowledge", exact: true }).waitFor();
    if (await page.getByText("pi-science:project-knowledge:start").count()) {
      throw new Error("Internal managed markers are visible in PROJECT.md preview");
    }

    await page.getByRole("tab", { name: /Inbox/ }).click();
    const knowledgeCard = page.locator("article").filter({ hasText: "Use Reviewer approval before project updates" });
    const fileCard = page.locator("article").filter({ hasText: "Move result into processed data" });
    await knowledgeCard.waitFor();
    await fileCard.waitFor();

    await fileCard.getByRole("button", { name: "Safety preview" }).click();
    await fileCard.getByText("Safety checks passed").waitFor();

    await knowledgeCard.getByRole("button", { name: "Accept", exact: true }).click();
    await page.getByText("Proposal accepted").waitFor();
    await page.getByRole("tab", { name: "Overview" }).click();
    await page.getByText("Use Reviewer approval before project updates").waitFor();

    await page.getByRole("tab", { name: /Inbox/ }).click();
    const remainingFileCard = page.locator("article").filter({ hasText: "Move result into processed data" });
    await remainingFileCard.getByRole("button", { name: "Accept", exact: true }).click();
    await waitForPath(path.join(workspace, "data", "processed", "result.csv"), true);
    await waitForPath(path.join(workspace, "result.csv"), false);

    await page.getByRole("tab", { name: "History" }).click();
    const fileHistory = page.locator("article").filter({ hasText: "file_operation.applied" }).first();
    await fileHistory.waitFor();
    await fileHistory.getByRole("button", { name: "Undo" }).click();
    await waitForPath(path.join(workspace, "result.csv"), true);

    await page.getByTitle("Toggle theme").click();
    if (await page.locator("html").getAttribute("data-theme") !== "dark") {
      throw new Error("Dark theme did not activate");
    }
    await page.screenshot({ path: desktopScreenshot, fullPage: true });

    await page.setViewportSize({ width: 375, height: 812 });
    const closeSidebar = page.getByRole("button", { name: "Close sidebar" }).last();
    if (await closeSidebar.isVisible()) await closeSidebar.click();
    await page.waitForTimeout(200);
    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    if (dimensions.scrollWidth > dimensions.innerWidth) {
      throw new Error(`Mobile layout overflows horizontally: ${dimensions.scrollWidth} > ${dimensions.innerWidth}`);
    }
    await page.screenshot({ path: mobileScreenshot, fullPage: true });

    const projectDocument = await readFile(path.join(workspace, "PROJECT.md"), "utf8");
    if (!projectDocument.includes("Use Reviewer approval before project updates")) {
      throw new Error("Accepted knowledge was not written to PROJECT.md");
    }

    console.log("PASS project overview and managed-marker hiding");
    console.log("PASS inbox cards and file safety preview");
    console.log("PASS knowledge approval writes PROJECT.md");
    console.log("PASS file move transaction and undo");
    console.log("PASS dark theme and 375px no-overflow layout");
    console.log(`SCREENSHOT ${desktopScreenshot}`);
    console.log(`SCREENSHOT ${mobileScreenshot}`);
  } finally {
    await browser.close();
    await rm(workspace, { recursive: true, force: true });
  }
}


run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
