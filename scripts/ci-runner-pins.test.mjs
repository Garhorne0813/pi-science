import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflows = ["quality.yml", "sandbox-acceptance.yml"];
const sources = workflows.map((file) => [file, readFileSync(join(root, ".github/workflows", file), "utf8")]);
const requests = sources.flatMap(([file, text]) => text.split("\n").flatMap((line, index) => {
  const value = line.match(/^\s*(?:runs-on|os):\s*(.+)$/)?.[1];
  if (value === undefined) return [];
  return value.replace(/^\[/, "").replace(/\]$/, "").split(",").map((entry) => entry.trim()).filter((entry) => /^(ubuntu|windows|macos)-/.test(entry)).map((label) => ({ file, line: index + 1, label }));
}));

const labels = (file) => requests.filter((request) => request.file === file).map((request) => request.label);
const ubuntuLabels = (file) => [...new Set(labels(file).filter((label) => label.startsWith("ubuntu-")))].sort();

test("every Linux leg runs on the verified Ubuntu 24.04 image", () => {
  for (const file of workflows) assert.deepEqual(ubuntuLabels(file), ["ubuntu-24.04"], `${file} requests ${JSON.stringify(ubuntuLabels(file))}`);
});

test("the pin keeps the Windows and macOS legs", () => {
  for (const label of ["windows-latest", "macos-latest"]) assert.ok(labels("quality.yml").includes(label), `quality.yml requests no ${label} runner`);
  assert.ok(labels("sandbox-acceptance.yml").includes("macos-latest"), "sandbox-acceptance.yml requests no macos-latest runner");
});

test("the quality workflow runs this test", () => {
  const lines = sources.find(([file]) => file === "quality.yml")[1].split("\n");
  assert.ok(lines.some((line) => line.includes("node --test") && line.includes("scripts/ci-runner-pins.test.mjs")), "quality.yml runs no node --test command that includes scripts/ci-runner-pins.test.mjs");
});
