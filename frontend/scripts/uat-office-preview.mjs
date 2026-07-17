import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import { chromium } from "playwright-core";


const frontend = process.env.PI_SCIENCE_FRONTEND_URL || "http://127.0.0.1:5173";
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const workspace = path.join(os.tmpdir(), `pi-science-office-uat-${process.pid}`);
const screenshots = {
  docx: path.join(os.tmpdir(), "pi-science-office-uat-docx.png"),
  xlsx: path.join(os.tmpdir(), "pi-science-office-uat-xlsx.png"),
  pptx: path.join(os.tmpdir(), "pi-science-office-uat-pptx.png"),
};


async function seedWorkspace() {
  await mkdir(workspace, { recursive: true });

  const docx = new Document({
    sections: [{
      children: [new Paragraph({
        children: [new TextRun({ text: "DOCX_UAT_TEXT", bold: true })],
      })],
    }],
  });
  await writeFile(path.join(workspace, "office-uat.docx"), await Packer.toBuffer(docx));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Results");
  sheet.addRow(["XLSX_UAT_TEXT", "value"]);
  sheet.addRow(["shikimate", 42]);
  await workbook.xlsx.writeFile(path.join(workspace, "office-uat.xlsx"));

  const pptx = new PptxGenJS();
  const slide = pptx.addSlide();
  slide.addText("PPTX_UAT_TEXT", { x: 1, y: 1, w: 6, h: 1, fontSize: 28, color: "1F2937" });
  await pptx.writeFile({ fileName: path.join(workspace, "office-uat.pptx") });
}


async function shadowSnapshot(page) {
  return page.evaluate(() => {
    const shadowText = [];
    for (const element of document.querySelectorAll("*")) {
      if (element.shadowRoot?.textContent) shadowText.push(element.shadowRoot.textContent);
    }
    return {
      body: document.body.innerText,
      shadow: shadowText.join("\n"),
    };
  });
}


async function waitForShadowText(page, expected, filename) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const snapshot = await shadowSnapshot(page);
    if (snapshot.shadow.includes(expected)) return;
    if (/render failed|could not render|cannot read|file not found/i.test(snapshot.body)) {
      throw new Error(`${filename} render error:\n${snapshot.body.slice(-2000)}`);
    }
    await page.waitForTimeout(250);
  }
  const snapshot = await shadowSnapshot(page);
  throw new Error(`${filename} did not render ${expected}. Body:\n${snapshot.body.slice(-2000)}\nShadow:\n${snapshot.shadow.slice(-2000)}`);
}


async function openAndVerify(page, filename, expected, screenshotPath) {
  console.log(`VERIFY ${filename}`);
  await page.getByRole("button", { name: new RegExp(filename.replace(".", "\\.")) }).click();
  await page.locator('[data-variant="file"]').waitFor();
  await waitForShadowText(page, expected, filename);
  const visibleError = page.getByText(/render failed|could not render|cannot read/i);
  if (await visibleError.count()) throw new Error(`${filename}: ${await visibleError.first().textContent()}`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.getByRole("button", { name: "Close", exact: true }).click();
}


async function run() {
  await seedWorkspace();
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/api/files/")) {
      console.log(`HTTP ${response.status()} ${response.url()}`);
    }
  });
  page.on("requestfailed", (request) => {
    if (request.url().includes("/api/files/")) {
      runtimeErrors.push(`Request failed ${request.url()}: ${request.failure()?.errorText}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  try {
    const route = `/workspace/${encodeURIComponent(workspace)}/files`;
    await page.goto(`${frontend}${route}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Files", exact: true }).waitFor();

    await openAndVerify(page, "office-uat.docx", "DOCX_UAT_TEXT", screenshots.docx);
    await openAndVerify(page, "office-uat.xlsx", "XLSX_UAT_TEXT", screenshots.xlsx);
    await openAndVerify(page, "office-uat.pptx", "PPTX_UAT_TEXT", screenshots.pptx);

    if (runtimeErrors.length) {
      throw new Error(`Browser runtime errors:\n${runtimeErrors.join("\n")}`);
    }
    console.log("PASS DOCX content rendered in inspector Shadow DOM");
    console.log("PASS XLSX content rendered in inspector Shadow DOM");
    console.log("PASS PPTX content rendered in inspector Shadow DOM");
    console.log(`SCREENSHOT ${screenshots.docx}`);
    console.log(`SCREENSHOT ${screenshots.xlsx}`);
    console.log(`SCREENSHOT ${screenshots.pptx}`);
  } finally {
    await browser.close();
    await rm(workspace, { recursive: true, force: true });
  }
}


run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
