import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./ui-verify/scenarios.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");


function spawnInherit(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}


function scenarioNameFrom(argv) {
  // pnpm forwards its own "--" separator, so the first token is often not a flag.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const index = args.indexOf("--scenario");
  if (index === -1) return undefined;
  return args[index + 1];
}


async function run() {
  const name = scenarioNameFrom(process.argv.slice(2));
  const scenario = name === undefined ? undefined : SCENARIOS[name];
  if (!scenario) {
    const problem = name === undefined ? "Missing --scenario <name>." : `Unknown scenario "${name}".`;
    process.stderr.write(`${problem} Registered scenarios: ${Object.keys(SCENARIOS).join(", ")}\n`);
    process.exit(1);
  }
  const buildCode = await spawnInherit("pnpm", ["--filter", "frontend", "build"]);
  if (buildCode !== 0) return buildCode;
  return spawnInherit("pnpm", [
    "--filter", "frontend", "exec", "playwright", "test",
    "--config", "playwright.visual.config.ts",
    scenario.spec,
    "--grep", scenario.grep,
  ]);
}


process.exitCode = await run();
