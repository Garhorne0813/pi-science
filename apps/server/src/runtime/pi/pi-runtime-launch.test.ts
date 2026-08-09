import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPiProcessOptions, loadDefaultPiConfig, resetWebRuntimeAllocation, runtimeExtensionStatus } from "./pi-runtime-launch.js";

const cleanup: string[] = [];
const original = { home: process.env.PI_SCIENCE_HOME, userHome: process.env.HOME, userProfile: process.env.USERPROFILE, cli: process.env.PI_CLI_PATH, tsx: process.env.PI_TSX_PATH, tsconfig: process.env.PI_TSCONFIG_PATH, piMode: process.env.PI_SCIENCE_PI_MODE };

beforeEach(async () => {
  const root = join(tmpdir(), `pi-science-runtime-launch-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(root);
  await mkdir(root, { recursive: true });
  process.env.PI_SCIENCE_HOME = join(root, "control-home");
  process.env.PI_CLI_PATH = join(root, "fake-pi.mjs");
  delete process.env.PI_SCIENCE_PI_MODE;
  // The shared port/token singleton must not leak across tests.
  resetWebRuntimeAllocation();
});

afterEach(async () => {
  process.env.PI_SCIENCE_HOME = original.home;
  if (original.userHome === undefined) delete process.env.HOME;
  else process.env.HOME = original.userHome;
  if (original.userProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = original.userProfile;
  process.env.PI_CLI_PATH = original.cli;
  process.env.PI_TSX_PATH = original.tsx;
  process.env.PI_TSCONFIG_PATH = original.tsconfig;
  if (original.piMode === undefined) delete process.env.PI_SCIENCE_PI_MODE;
  else process.env.PI_SCIENCE_PI_MODE = original.piMode;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function obstructModelsFile(customProviders?: unknown[]): Promise<string> {
  const cwd = join(tmpdir(), `pi-science-runtime-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(cwd);
  await mkdir(cwd, { recursive: true });
  const agentDir = join(process.env.PI_SCIENCE_HOME!, "pi-agent", "web-host");
  await mkdir(join(agentDir, "models.json"), { recursive: true });
  await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
  await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), `${JSON.stringify({ custom_providers: customProviders ?? [] })}\n`, "utf8");
  return cwd;
}

describe("Pi runtime custom provider materialization", () => {
  it("infers DeepSeek V4 custom models as reasoning-capable", async () => {
    const cwd = join(tmpdir(), `pi-runtime-deepseek-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), `${JSON.stringify({
      custom_providers: [{ id: "deepseek", name: "DeepSeek", base_url: "https://api.deepseek.com", api: "openai-completions", models: ["deepseek-v4-flash"] }],
    })}\n`, "utf8");

    buildPiProcessOptions(cwd);

    const catalog = JSON.parse(await readFile(join(process.env.PI_SCIENCE_HOME!, "pi-agent", "web-host", "models.json"), "utf8"));
    expect(catalog.providers["custom-deepseek"].models[0]).toMatchObject({
      id: "deepseek-v4-flash",
      reasoning: true,
      thinkingLevelMap: expect.objectContaining({ low: "low", high: "high", xhigh: "xhigh" }),
    });
  });

  it("materializes custom reasoning metadata and percentage-based compaction settings", async () => {
    const cwd = join(tmpdir(), `pi-runtime-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    buildPiProcessOptions(cwd, {
      model: "custom-local/model-a",
      thinking: "high",
      compaction_enabled: true,
      compaction_threshold_percent: 80,
      model_context_window: 100000,
      skills: [],
      extensions: [],
    });
    const settings = JSON.parse(await readFile(join(process.env.PI_SCIENCE_HOME!, "pi-agent", "web-host", "settings.json"), "utf8"));
    expect(settings.compaction).toMatchObject({ enabled: true, reserveTokens: 20000, keepRecentTokens: 20000 });
  });

  it("materializes follow-up suggestion guidance as the agent append system prompt", async () => {
    const cwd = join(tmpdir(), `pi-runtime-append-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    buildPiProcessOptions(cwd);
    const guidance = await readFile(join(process.env.PI_SCIENCE_HOME!, "pi-agent", "web-host", "APPEND_SYSTEM.md"), "utf8");
    expect(guidance).toContain("<!--suggest: q1 | q2 | q3-->");
    expect(guidance).toContain("up to 3 short, concrete follow-up suggestions");
    expect(guidance).toContain("standalone message the user can copy and send directly");
    expect(guidance).toContain("written from the user's perspective as a request, question, or imperative");
    expect(guidance).toContain("Do not use assistant/agent-offering language");
    expect(guidance).toContain("我可以… / 要不要我… / I can… / Would you like me to…");
    expect(guidance).toContain("do not address the user as 你 or you when describing the agent's next step");
    expect(guidance).toContain("Use the user's language");
    expect(guidance).toContain("omit the comment when no meaningful follow-up remains");
  });

  it("materializes multi-step todo guidance in the append system prompt", async () => {
    const cwd = join(tmpdir(), `pi-runtime-todo-guidance-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    buildPiProcessOptions(cwd);
    const guidance = await readFile(join(process.env.PI_SCIENCE_HOME!, "pi-agent", "web-host", "APPEND_SYSTEM.md"), "utf8");
    expect(guidance).toContain("call the todo tool (action: create)");
    expect(guidance).toContain("exactly one task in_progress at a time");
    expect(guidance).toContain("Simple single-step requests do not need a todo list");
  });

  it("passes workspace package isolation into the agent runtime", async () => {
    const cwd = join(tmpdir(), `pi-runtime-environment-${Date.now()}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    const isolated = {
      PATH: join(cwd, ".venv", "bin"),
      VIRTUAL_ENV: join(cwd, ".venv"),
      PIP_REQUIRE_VIRTUALENV: "1",
      npm_config_prefix: join(cwd, ".pi-science", "npm-global"),
    };

    const options = buildPiProcessOptions(cwd, undefined, undefined, isolated)!;

    expect(options.env).toMatchObject(isolated);
  });

  it("passes a manifest-discovered runtime extension exactly once", async () => {
    const runtimeRoot = join(tmpdir(), `pi-runtime-manifest-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const cwd = join(tmpdir(), `pi-runtime-extension-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(runtimeRoot, cwd);
    const cli = join(runtimeRoot, "packages", "coding-agent", "dist", "cli.js");
    const extension = join(runtimeRoot, "node_modules", "pi-subagents", "src", "extension.ts");
    await mkdir(join(runtimeRoot, "packages", "coding-agent", "dist"), { recursive: true });
    await mkdir(join(runtimeRoot, "node_modules", "pi-subagents", "src"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(cli, "", "utf8");
    await writeFile(extension, "export default function extension() {}\n", "utf8");
    await writeFile(join(runtimeRoot, "node_modules", "pi-subagents", "package.json"), JSON.stringify({ pi: { extensions: ["src/extension.ts"] } }), "utf8");
    process.env.PI_CLI_PATH = cli;

    // Inject the test runtime root explicitly: without it, a vendored
    // managed runtime checkout (runtime/pi) shadows this tmpdir scenario.
    const options = buildPiProcessOptions(cwd, loadDefaultPiConfig([runtimeRoot]))!;
    const extensions = options.args.flatMap((arg, index) => arg === "-e" ? [options.args[index + 1]] : []);

    expect(extensions.filter((path) => path === extension)).toHaveLength(1);
    expect(extensions).not.toContain("pi-subagents/index.ts");
  });

  it("discovers the registered rpiv-todo extension from an injected package root", async () => {
    const runtimeRoot = join(tmpdir(), `pi-runtime-todo-manifest-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const cli = join(runtimeRoot, "packages", "coding-agent", "dist", "cli.js");
    const packageDir = join(runtimeRoot, "node_modules", "@juicesharp", "rpiv-todo");
    const extension = join(packageDir, "index.ts");
    cleanup.push(runtimeRoot);
    await mkdir(join(runtimeRoot, "packages", "coding-agent", "dist"), { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeFile(cli, "", "utf8");
    await writeFile(extension, "export default function extension() {}\n", "utf8");
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }), "utf8");

    const todo = runtimeExtensionStatus(cli, [runtimeRoot]).find((item) => item.id === "rpiv-todo");
    const config = loadDefaultPiConfig([runtimeRoot]);

    expect(todo).toMatchObject({ id: "rpiv-todo", name: "Todo", installed: true, path: extension });
    expect(config.extensions).toContain(extension);
  });

  it("auto-discovers rpiv-todo from Pi's managed npm root", async () => {
    const installHome = join(tmpdir(), `pi-runtime-todo-home-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const packageDir = join(installHome, ".pi", "agent", "npm", "node_modules", "@juicesharp", "rpiv-todo");
    const extension = join(packageDir, "index.ts");
    cleanup.push(installHome);
    await mkdir(packageDir, { recursive: true });
    await writeFile(extension, "export default function extension() {}\n", "utf8");
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ pi: { extensions: ["index.ts"] } }), "utf8");
    process.env.HOME = installHome;
    // os.homedir() reads USERPROFILE on Windows (HOME is not consulted), so the
    // managed-npm-root discovery test must override both or it cannot find the
    // injected package on windows runners.
    process.env.USERPROFILE = installHome;

    const todo = runtimeExtensionStatus(process.env.PI_CLI_PATH!, [join(installHome, ".pi", "agent", "npm")]).find((item) => item.id === "rpiv-todo");

    expect(todo).toMatchObject({ installed: true, path: extension });
  });

  it("uses the Pi-Science questionnaire bridge instead of registering the upstream duplicate tool", async () => {
    const cwd = join(tmpdir(), `pi-runtime-questionnaire-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    const upstream = join(cwd, "node_modules", "@juicesharp", "rpiv-ask-user-question", "index.ts");
    const options = buildPiProcessOptions(cwd, { skills: [], extensions: [upstream] })!;
    const extensions = options.args.flatMap((arg, index) => arg === "-e" ? [options.args[index + 1]] : []);
    const adapter = join(import.meta.dirname, "extensions", "pi-science-ask-user-question-web.ts");

    expect(extensions[0]).toBe(adapter);
    expect(extensions).not.toContain(upstream);
  });

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

  it("runs a native Pi Orbit release executable directly", async () => {
    const cwd = join(tmpdir(), `pi-runtime-native-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    const cli = join(cwd, "pi-orbit");
    await writeFile(cli, "", "utf8");
    process.env.PI_CLI_PATH = cli;

    const options = buildPiProcessOptions(cwd)!;

    expect(options.command).toBe(cli);
    expect(options.args[0]).toBe("--mode");
    expect(options.args).not.toContain(cli);
  });

  it("launches Pi in authenticated app-managed web mode", async () => {
    const cwd = join(tmpdir(), `pi-runtime-web-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });

    const options = buildPiProcessOptions(cwd)!;

    expect(options.args).toContain("web");
    expect(options.args).not.toContain("rpc");
    expect(options.args).toContain("--web-app-managed");
    expect(options.args).toContain("--no-session");
    expect(options.args).toContain("--approve");
    expect(options.args).not.toContain("--session-dir");
    expect(options.args).not.toContain("--auth-token");
    expect(options.web?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(options.web?.authToken).toBeTruthy();
    expect(options.env?.PI_ORBIT_AUTH_TOKEN).toBe(options.web?.authToken);
    expect(options.web?.runtime).toMatchObject({ cwd, sessionDir: join(cwd, ".pi-science", "sessions") });
  });

  it("allows isolated runtimes to override the web session directory", async () => {
    const cwd = join(tmpdir(), `pi-runtime-isolated-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const isolatedSessions = join(cwd, ".pi-science", "title-runtimes", "runtime-1");
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });

    const options = buildPiProcessOptions(cwd, undefined, undefined, {}, isolatedSessions)!;

    expect(options.web?.runtime.sessionDir).toBe(isolatedSessions);
    expect(options.web?.runtime.sessionDir).not.toBe(join(cwd, ".pi-science", "sessions"));
  });

  it("reuses the shared web port and token until reset allocates fresh ones", () => {
    const cwd = join(tmpdir(), `pi-runtime-shared-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    mkdirSync(cwd, { recursive: true });
    const first = buildPiProcessOptions(cwd)!;
    const second = buildPiProcessOptions(cwd)!;
    expect(second.web?.baseUrl).toBe(first.web?.baseUrl);
    expect(second.web?.authToken).toBe(first.web?.authToken);

    // A host start failure (e.g. EADDRINUSE) resets the singleton so the next
    // attempt self-heals with a different port/token.
    resetWebRuntimeAllocation();
    const after = buildPiProcessOptions(cwd)!;
    expect(after.web?.baseUrl).not.toBe(first.web?.baseUrl);
    expect(after.web?.authToken).not.toBe(first.web?.authToken);
  });

  it("reuses one port and auth token across calls instead of leaking new ones", async () => {
    const cwd = join(tmpdir(), `pi-runtime-shared-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });

    const first = buildPiProcessOptions(cwd)!;
    const second = buildPiProcessOptions(cwd)!;
    const third = buildPiProcessOptions(cwd)!;

    expect(second.web?.baseUrl).toBe(first.web?.baseUrl);
    expect(third.web?.baseUrl).toBe(first.web?.baseUrl);
    expect(second.web?.authToken).toBe(first.web?.authToken);
    expect(third.env?.PI_ORBIT_AUTH_TOKEN).toBe(first.env?.PI_ORBIT_AUTH_TOKEN);
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
