import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const dist = new URL("../dist/assets/", import.meta.url);
const files = await readdir(dist);
const budget = Number(process.env.PI_SCIENCE_ENTRY_BUDGET || 300_000);
const entries = [];
for (const file of files) {
  if (!file.endsWith(".js") || file.startsWith("vendor-")) continue;
  const info = await stat(join(dist.pathname, file));
  entries.push({ file, size: info.size });
}
const failures = entries.filter((entry) => entry.size > budget);
const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const initialFiles = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((match) => match[1]);
const initial = [];
for (const file of initialFiles) {
  const info = await stat(join(dist.pathname, file));
  initial.push({ file, size: info.size });
}
const initialBudget = Number(process.env.PI_SCIENCE_INITIAL_JS_BUDGET || 1_500_000);
const initialTotal = initial.reduce((total, entry) => total + entry.size, 0);
const lazyOnly = ["vendor-echarts", "vendor-3dmol", "vendor-three", "vendor-exceljs", "vendor-docx", "vendor-pptx", "vendor-openchemlib"];
const eagerlyLoadedHeavyChunks = initial.filter((entry) => lazyOnly.some((prefix) => entry.file.startsWith(prefix)));
for (const entry of entries.sort((a, b) => b.size - a.size)) {
  console.log(`${entry.file}\t${entry.size} bytes`);
}
if (failures.length) {
  console.error(`Bundle budget exceeded (${budget} bytes): ${failures.map((item) => item.file).join(", ")}`);
  process.exit(1);
}
console.log(`initial-js\t${initialTotal} bytes`);
if (initialTotal > initialBudget || eagerlyLoadedHeavyChunks.length) {
  if (initialTotal > initialBudget) console.error(`Initial JS budget exceeded (${initialBudget} bytes)`);
  if (eagerlyLoadedHeavyChunks.length) console.error(`Lazy-only chunks loaded eagerly: ${eagerlyLoadedHeavyChunks.map((item) => item.file).join(", ")}`);
  process.exit(1);
}
