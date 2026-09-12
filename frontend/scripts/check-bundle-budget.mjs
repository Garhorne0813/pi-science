import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const dist = fileURLToPath(new URL("../dist/assets/", import.meta.url));
const files = await readdir(dist);
const budget = Number(process.env.PI_SCIENCE_ENTRY_BUDGET || 300_000);
const entries = [];
for (const file of files) {
  if (!file.endsWith(".js") || file.startsWith("vendor-")) continue;
  const info = await stat(join(dist, file));
  entries.push({ file, size: info.size });
}
// Mol* is intentionally large and Rolldown can split its lazy graph at several
// internal module boundaries. These chunks must remain molecule-only; the
// initial-graph assertion below guards that boundary.
const allowedLazyLarge = ["app-", "molecular-surface-", "plugin-spec-", "spec-"];
const failures = entries.filter((entry) => entry.size > budget && !allowedLazyLarge.some((prefix) => entry.file.startsWith(prefix)));
const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const initialFiles = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((match) => match[1]);
const initial = [];
for (const file of initialFiles) {
  const info = await stat(join(dist, file));
  const contents = await readFile(join(dist, file));
  initial.push({ file, size: info.size, gzipSize: gzipSync(contents).byteLength });
}
const initialBudget = Number(process.env.PI_SCIENCE_INITIAL_JS_BUDGET || 1_250_000);
const initialGzipBudget = Number(process.env.PI_SCIENCE_INITIAL_JS_GZIP_BUDGET || 400_000);
const initialTotal = initial.reduce((total, entry) => total + entry.size, 0);
const initialGzipTotal = initial.reduce((total, entry) => total + entry.gzipSize, 0);
const lazyOnly = ["InspectorTabs-", "SettingsDialog-", "vendor-echarts", ...allowedLazyLarge, "molstar-", "vendor-three", "vendor-exceljs", "vendor-docx", "vendor-pptx", "vendor-openchemlib", "vendor-progress"];
const eagerlyLoadedHeavyChunks = initial.filter((entry) => lazyOnly.some((prefix) => entry.file.startsWith(prefix)));
// The animation runtime is one async chunk by design; a split means something
// started reaching into its graph from a static import.
const progressChunks = files.filter((file) => file.startsWith("vendor-progress") && file.endsWith(".js"));
for (const entry of entries.sort((a, b) => b.size - a.size)) {
  console.log(`${entry.file}\t${entry.size} bytes`);
}
if (failures.length) {
  console.error(`Bundle budget exceeded (${budget} bytes): ${failures.map((item) => item.file).join(", ")}`);
  process.exit(1);
}
console.log(`initial-js\t${initialTotal} bytes`);
console.log(`initial-js-gzip\t${initialGzipTotal} bytes`);
if (initialTotal > initialBudget || initialGzipTotal > initialGzipBudget || eagerlyLoadedHeavyChunks.length || progressChunks.length > 1) {
  if (initialTotal > initialBudget) console.error(`Initial JS budget exceeded (${initialBudget} bytes)`);
  if (initialGzipTotal > initialGzipBudget) console.error(`Initial gzipped JS budget exceeded (${initialGzipBudget} bytes)`);
  if (eagerlyLoadedHeavyChunks.length) console.error(`Lazy-only chunks loaded eagerly: ${eagerlyLoadedHeavyChunks.map((item) => item.file).join(", ")}`);
  if (progressChunks.length > 1) console.error(`vendor-progress split into ${progressChunks.length} chunks: ${progressChunks.join(", ")}`);
  process.exit(1);
}
