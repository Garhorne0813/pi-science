import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPiProcessOptions } from "./pi-runtime-launch.js";

const cleanup: string[] = [];
const original = { home: process.env.PI_SCIENCE_HOME, cli: process.env.PI_CLI_PATH, tsx: process.env.PI_TSX_PATH, tsconfig: process.env.PI_TSCONFIG_PATH };

beforeEach(async () => {
  const root = join(tmpdir(), `pi-science-runtime-launch-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(root);
  await mkdir(root, { recursive: true });
  process.env.PI_SCIENCE_HOME = join(root, "control-home");
  process.env.PI_CLI_PATH = join(root, "fake-pi.mjs");
});

afterEach(async () => {
  process.env.PI_SCIENCE_HOME = original.home;
  process.env.PI_CLI_PATH = original.cli;
  process.env.PI_TSX_PATH = original.tsx;
  process.env.PI_TSCONFIG_PATH = original.tsconfig;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function obstructModelsFile(customProviders?: unknown[]): Promise<string> {
  const cwd = join(tmpdir(), `pi-science-runtime-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(cwd);
  await mkdir(cwd, { recursive: true });
  const workspaceKey = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12);
  const agentDir = join(process.env.PI_SCIENCE_HOME!, "pi-agent", workspaceKey);
  await mkdir(join(agentDir, "models.json"), { recursive: true });
  await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
  await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), `${JSON.stringify({ custom_providers: customProviders ?? [] })}\n`, "utf8");
  return cwd;
}

describe("Pi runtime custom provider materialization", () => {
  it("runs a source TypeScript CLI through the adjacent tsx runtime", async () => {
    const piRoot = join(tmpdir(), `pi-source-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(piRoot);
    const cli = join(piRoot, "packages", "coding-agent", "src", "cli.ts");
    const tsx = join(piRoot, "node_modules", ".bin", "tsx");
    await mkdir(join(piRoot, "packages", "coding-agent", "src"), { recursive: true });
    await mkdir(join(piRoot, "node_modules", ".bin"), { recursive: true });
    await writeFile(cli, "export {};\n", "utf8");
    await writeFile(tsx, "", "utf8");
    process.env.PI_CLI_PATH = cli;
    delete process.env.PI_TSX_PATH;
    delete process.env.PI_TSCONFIG_PATH;

    const options = buildPiProcessOptions(piRoot)!;
    expect(options.args.slice(0, 2)).toEqual([tsx, cli]);
  });

  it("surfaces models.json deletion failures except for a missing file", async () => {
    const cwd = await obstructModelsFile();
    expect(() => buildPiProcessOptions(cwd)).toThrow(/EISDIR|operation not permitted|permission denied/i);
  });

  it("surfaces models.json write failures", async () => {
    const cwd = await obstructModelsFile([{ id: "local", name: "Local", base_url: "http://127.0.0.1:11434/v1", api: "openai-completions", models: ["local-model"] }]);
    expect(() => buildPiProcessOptions(cwd)).toThrow(/EISDIR|operation not permitted|permission denied/i);
  });
});
