import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import prettier from "prettier";
import { sourceFiles } from "./source-files.mjs";
const rootOption = process.argv.indexOf("--root");
if (rootOption >= 0) process.chdir(process.argv[rootOption + 1]);
const baselinePath = "scripts/architecture/format-baseline.json";
const files = [
  ...(await sourceFiles("apps/server/src")),
  ...(await sourceFiles("packages/contracts/src")),
  ...(await sourceFiles("scripts/architecture")),
];
const baseline = JSON.parse(await readFile(baselinePath, "utf8").catch(() => "{}"));
const remaining = {};
const failures = [];
for (const file of files) {
  // Git autocrlf and editors must not invalidate legacy hashes or formatting.
  const text = (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
  const options = { ...(await prettier.resolveConfig(file)), filepath: file };
  if (await prettier.check(text, options)) continue;
  const hash = createHash("sha256").update(text).digest("hex");
  if (process.argv.includes("--baseline")) remaining[file] = hash;
  else if (baseline[file] !== hash) {
    if (process.argv.includes("--write"))
      await writeFile(file, await prettier.format(text, options));
    else failures.push(file);
  }
}
if (process.argv.includes("--baseline"))
  await writeFile(baselinePath, JSON.stringify(remaining, null, 2) + "\n");
if (failures.length) {
  console.error("Format new or changed files with pnpm format:\n" + failures.join("\n"));
  process.exitCode = 1;
}
