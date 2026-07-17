import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";


const frontend = process.env.PI_SCIENCE_FRONTEND_URL || "http://127.0.0.1:5173";
const backend = process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787";
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const workspace = path.join(os.tmpdir(), `pi-science-notebook-uat-${process.pid}`);
const screenshot = path.join(os.tmpdir(), "pi-science-notebook-uat.png");


async function api(endpoint, init) {
  const response = await fetch(`${backend}${endpoint}`, init);
  if (!response.ok) throw new Error(`${endpoint}: ${response.status} ${await response.text()}`);
  return response.json();
}


async function seedWorkspace() {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "analysis.ipynb"), JSON.stringify({
    cells: [
      { cell_type: "markdown", metadata: {}, source: ["# Notebook UI UAT"] },
      {
        cell_type: "code",
        execution_count: 1,
        metadata: {},
        outputs: [{ output_type: "stream", name: "stdout", text: ["stored output\\n"] }],
        source: ["x = 40"],
      },
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: ["x + 2"],
      },
    ],
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 2));
}


async function waitForKernelCount(expected) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await api("/api/kernels/status");
    if (status.active_count === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Kernel count did not become ${expected}`);
}


async function run() {
  await seedWorkspace();
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  try {
    const route = `/workspace/${encodeURIComponent(workspace)}/notebooks`;
    await page.goto(`${frontend}${route}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Notebooks", exact: true }).waitFor();
    await page.getByRole("button", { name: /analysis\.ipynb/ }).click();
    await page.getByText("Notebook UI UAT").waitFor();
    await page.getByText("stored output").waitFor();

    await page.getByRole("button", { name: "Run code cell 2" }).click();
    await page.getByRole("button", { name: "Run code cell 2" }).getByText("Run", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Run code cell 3" }).click();
    await page.locator('[data-variant="notebook-file"]').getByText("42", { exact: true }).waitFor();
    const status = await waitForKernelCount(1);
    const session = status.sessions.find((item) => item.notebook_id.startsWith("file-"));
    if (!session || path.resolve(session.cwd) !== await realpath(workspace)) {
      throw new Error(`Notebook kernel used the wrong workspace: ${JSON.stringify(status.sessions)}`);
    }
    await page.screenshot({ path: screenshot, fullPage: true });

    await page.getByRole("button", { name: "Close notebook" }).click();
    await waitForKernelCount(0);
    if (runtimeErrors.length) throw new Error(`Browser runtime errors:\n${runtimeErrors.join("\n")}`);

    console.log("PASS notebook markdown and stored output rendered");
    console.log("PASS sequential cells shared a workspace-scoped kernel and returned 42");
    console.log("PASS closing the inspector shut down the notebook kernel");
    console.log(`SCREENSHOT ${screenshot}`);
  } finally {
    await browser.close();
    await api("/api/kernels/shutdown-all", { method: "POST" }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}


run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
