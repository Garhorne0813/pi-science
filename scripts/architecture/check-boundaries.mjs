import { readFile, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import typescript from "prettier/plugins/typescript";
import { sourceFiles } from "./source-files.mjs";
const rootOption = process.argv.indexOf("--root");
if (rootOption >= 0) process.chdir(process.argv[rootOption + 1]);
const baselinePath = "scripts/architecture/boundary-baseline.json";
const files = [
  ...(await sourceFiles("apps/server/src")),
  ...(await sourceFiles("packages/contracts/src")),
].filter((file) => !/\.(?:test|type-test)\.tsx?$/.test(file));
const known = new Set(files);
const graph = new Map();
const violations = new Set();
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "range", "tokens", "comments", "parent"].includes(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value === "object") walk(value, visit);
  }
}
for (const file of files) {
  const ast = typescript.parsers.typescript.parse(await readFile(file, "utf8"), { filepath: file });
  if (
    /\/(?:[^/]*-repository|repository)\.ts$/.test(file) &&
    file.startsWith("apps/server/src/") &&
    !file.startsWith("apps/server/src/modules/")
  )
    violations.add("legacy-repository-location: " + file);
  const edges = new Set();
  graph.set(file, edges);
  walk(ast, (node) => {
    const domainOwner =
      file.startsWith("apps/server/src/modules/") || file.startsWith("apps/server/src/memory/");
    if (
      domainOwner &&
      node.type === "NewExpression" &&
      /(?:Service|Repository|Store|EventHub|Background)$/.test(node.callee?.name ?? "")
    )
      violations.add("owned-dependency: " + file + " constructs " + node.callee.name);
    let source;
    let typeOnly = false;
    if (
      ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)
    ) {
      source = node.source?.value;
      typeOnly =
        node.importKind === "type" ||
        node.exportKind === "type" ||
        (node.type === "ImportDeclaration" &&
          node.specifiers.length > 0 &&
          node.specifiers.every((item) => item.importKind === "type"));
    } else if (node.type === "ImportExpression") source = node.source?.value;
    else if (node.type === "TSImportType") {
      source = node.argument?.value ?? node.argument?.literal?.value;
      typeOnly = true;
    } else if (node.type === "CallExpression" && node.callee?.name === "require")
      source = node.arguments[0]?.value;
    if (typeof source !== "string") return;
    const target = source.startsWith(".")
      ? posix.normalize(posix.join(posix.dirname(file), source)).replace(/\.js$/, ".ts")
      : source;
    const edge = `${file} -> ${target}`;
    const domain =
      file.startsWith("apps/server/src/modules/") || file.startsWith("apps/server/src/memory/");
    const mechanism =
      file.startsWith("apps/server/src/runtime/") || file.startsWith("apps/server/src/storage/");
    if ((domain || mechanism) && /apps\/server\/src\/(?:http|app)\//.test(target))
      violations.add("layer: " + edge);
    if (file.startsWith("apps/server/src/modules/") && target.includes("/runtime/"))
      violations.add("domain-runtime: " + edge);
    if (
      domain &&
      node.type === "ImportDeclaration" &&
      node.specifiers.some((item) =>
        [
          "sessionRepository",
          "executionRepository",
          "conversationEventHub",
          "durableEventStore",
        ].includes(item.imported?.name),
      )
    )
      violations.add("singleton: " + edge);
    if (file.startsWith("packages/contracts/src/") && target === "packages/contracts/src/index.ts")
      violations.add("contracts-barrel: " + edge);
    if (!typeOnly && known.has(target)) edges.add(target);
  });
}
// Tarjan SCC detects runtime dependency cycles. Type-only ports do not create runtime edges.
const indexes = new Map(),
  lows = new Map(),
  stack = [],
  active = new Set();
let next = 0;
function connect(file) {
  indexes.set(file, next);
  lows.set(file, next++);
  stack.push(file);
  active.add(file);
  for (const target of graph.get(file) ?? []) {
    if (!indexes.has(target)) {
      connect(target);
      lows.set(file, Math.min(lows.get(file), lows.get(target)));
    } else if (active.has(target)) lows.set(file, Math.min(lows.get(file), indexes.get(target)));
  }
  if (lows.get(file) !== indexes.get(file)) return;
  const group = [];
  let member;
  do {
    member = stack.pop();
    active.delete(member);
    group.push(member);
  } while (member !== file);
  if (group.length < 2 && !graph.get(file)?.has(file)) return;
  const members = new Set(group);
  for (const source of group)
    for (const target of graph.get(source) ?? [])
      if (members.has(target)) violations.add(`cycle: ${source} -> ${target}`);
}
for (const file of files) if (!indexes.has(file)) connect(file);
const actual = [...violations].sort();
if (process.argv.includes("--baseline"))
  await writeFile(baselinePath, JSON.stringify(actual, null, 2) + "\n");
else {
  const allowed = new Set(JSON.parse(await readFile(baselinePath, "utf8")));
  const additions = actual.filter((item) => !allowed.has(item));
  const stale = [...allowed].filter((item) => !violations.has(item));
  if (additions.length || stale.length) {
    console.error(
      [
        ...additions.map((item) => "New violation: " + item),
        ...stale.map((item) => "Remove obsolete exception: " + item),
      ].join("\n"),
    );
    process.exitCode = 1;
  }
}
