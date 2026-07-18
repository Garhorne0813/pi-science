import { readdir, stat } from "node:fs/promises";
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
for (const entry of entries.sort((a, b) => b.size - a.size)) {
  console.log(`${entry.file}\t${entry.size} bytes`);
}
if (failures.length) {
  console.error(`Bundle budget exceeded (${budget} bytes): ${failures.map((item) => item.file).join(", ")}`);
  process.exit(1);
}
