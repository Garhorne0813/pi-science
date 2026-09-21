import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { probeAsync, sandboxConversationCommand, sandboxResearchCommand, researchSandboxStatus, windowsResearchSandboxConfig } from "./research-sandbox.js";
import { metadataRoot } from "../../storage/persistence.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it("fails closed on platforms without a native sandbox", () => {
  expect(researchSandboxStatus("freebsd")).toEqual({ available: false, reason: "local research sandbox is unavailable on freebsd" });
});

it("runs sandbox preflight without blocking the control-plane event loop", async () => {
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 20);
  const check = probeAsync(process.execPath, ["-e", "setTimeout(() => {}, 150)"], { timeoutMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(timerFired).toBe(true);
  expect((await check).status).toBe(0);
  clearTimeout(timer);
});

it("requires an absolute Windows sandbox executable path", () => {
  const old = process.env.PI_SCIENCE_SANDY_PATH;
  try {
    process.env.PI_SCIENCE_SANDY_PATH = "sandy.exe";
    expect(researchSandboxStatus("win32")).toEqual({ available: false, reason: "set PI_SCIENCE_SANDY_PATH to an absolute sandy.exe path" });
  } finally {
    if (old === undefined) delete process.env.PI_SCIENCE_SANDY_PATH;
    else process.env.PI_SCIENCE_SANDY_PATH = old;
  }
});

it("renders a Windows AppContainer policy with no network or profile access", () => {
  const config = windowsResearchSandboxConfig({
    commandPath: "C:\\Users\\researcher\\tools\\node.exe",
    executionCwd: "C:\\Users\\researcher\\project\\.pi-science\\runs\\run-1\\work",
    readable: ["C:\\Users\\researcher\\env"],
    writable: ["C:\\Users\\researcher\\project\\.pi-science\\runs\\run-1\\outputs"],
    executableRoots: ["C:\\Users\\researcher\\env"],
  });
  expect(config).toContain("token = 'appcontainer'");
  expect(config).toContain("network = false");
  expect(config).toContain("lan = false");
  expect(config).toContain("processes = 64");
  expect(config).toContain('"C:\\\\Users\\\\researcher\\\\tools"');
  expect(config).toContain('"C:\\\\Users\\\\researcher\\\\env"');
  expect(config).toContain('read = ["C:\\\\Users\\\\researcher\\\\env"]');
  expect(config).not.toContain("restricted");
});

it("runs a research candidate with only its work and output directories writable", async () => {
  if (process.platform === "win32") return;
  const status = researchSandboxStatus();
  if (!status.available) return;
  const workspace = await mkdtemp(join(tmpdir(), "pi-science-sandbox-"));
  cleanup.push(workspace);
  const run = join(metadataRoot(workspace), "runs", "run-test");
  const work = join(run, "work"); const outputs = join(run, "outputs");
  await mkdir(work, { recursive: true }); await mkdir(outputs);
  await writeFile(join(workspace, "private.txt"), "secret");
  const script = join(work, "solve.sh");
  await writeFile(script, 'printf "ok" > "$PI_SCIENCE_OUTPUT_DIR/result.txt"\ncat "$PI_SCIENCE_OUTPUT_DIR/result.txt"\nif printf "hacked" > "$PI_SCIENCE_WORKSPACE_SECRET" 2>/dev/null; then echo WRITE_ESCAPED; fi\nln -s "$PI_SCIENCE_WORKSPACE_SECRET" "$PI_SCIENCE_OUTPUT_DIR/link" 2>/dev/null\nif printf "escaped" > "$PI_SCIENCE_OUTPUT_DIR/link" 2>/dev/null; then echo SYMLINK_ESCAPED; fi\nif cat "$PI_SCIENCE_WORKSPACE_SECRET" 2>/dev/null; then echo READ_ESCAPED; fi\n');
  const isolated = await sandboxResearchCommand({ command: ["/bin/bash", script], workspace, executionCwd: work, surface: "research-loop", environment: { PATH: process.env.PATH, PI_SCIENCE_OUTPUT_DIR: outputs, PI_SCIENCE_WORKSPACE_SECRET: join(workspace, "private.txt") } });
  const result = spawnSync(isolated.command[0]!, isolated.command.slice(1), { cwd: work, env: isolated.environment, encoding: "utf8" });
  expect(await readFile(join(outputs, "result.txt"), "utf8")).toBe("ok");
  expect(result.stdout).toContain("ok");
  // Bubblewrap's private tmpfs can hold a same-named shadow file. The host
  // secret must remain unreadable and unchanged even if the script makes one.
  expect(result.stdout).not.toContain("secret");
  expect(await readFile(join(workspace, "private.txt"), "utf8")).toBe("secret");
});

it("runs a local Node evaluator inside the research sandbox", async () => {
  const status = researchSandboxStatus();
  if (process.platform === "darwin") expect(status.available).toBe(true);
  if (!status.available) return;
  const workspace = await mkdtemp(join(tmpdir(), "pi-science-sandbox-"));
  cleanup.push(workspace);
  const evaluator = join(metadataRoot(workspace), "runs", "run-test", "evaluator");
  await mkdir(evaluator, { recursive: true });
  const script = join(evaluator, "evaluate.mjs");
  const resultPath = join(evaluator, "evaluation.json");
  await writeFile(script, 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.PI_SCIENCE_EVALUATION_PATH, "ok");');
  const isolated = await sandboxResearchCommand({ command: [process.execPath, script], workspace, executionCwd: evaluator, surface: "research-evaluator", environment: { PATH: process.env.PATH, PI_SCIENCE_EVALUATION_PATH: resultPath } });
  const result = spawnSync(isolated.command[0]!, isolated.command.slice(1), { cwd: evaluator, env: isolated.environment, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(await readFile(resultPath, "utf8")).toBe("ok");
});

it("confines a Windows candidate to its run directories", async () => {
  if (process.platform !== "win32" || !researchSandboxStatus().available) return;
  const workspace = await mkdtemp(join(tmpdir(), "pi-science-sandbox-win-"));
  cleanup.push(workspace);
  const run = join(metadataRoot(workspace), "runs", "run-test");
  const work = join(run, "work"); const outputs = join(run, "outputs");
  await mkdir(work, { recursive: true }); await mkdir(outputs);
  const secret = join(workspace, "private.txt");
  await writeFile(secret, "secret");
  const script = join(work, "candidate.cjs");
  await writeFile(script, `const fs=require('node:fs'); const path=require('node:path');
    let blocked=false; try { fs.readFileSync(process.env.PI_SCIENCE_WORKSPACE_SECRET); } catch { blocked=true; }
    fs.writeFileSync(path.join(process.env.PI_SCIENCE_OUTPUT_DIR,'result.json'),JSON.stringify({blocked}));`);
  const isolated = await sandboxResearchCommand({ command: [process.execPath, script], workspace, executionCwd: work, surface: "research-loop", environment: { PATH: process.env.PATH, PI_SCIENCE_OUTPUT_DIR: outputs, PI_SCIENCE_WORKSPACE_SECRET: secret } });
  const result = spawnSync(isolated.command[0]!, isolated.command.slice(1), { cwd: work, env: isolated.environment, encoding: "utf8", timeout: 15_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(await readFile(join(outputs, "result.json"), "utf8"))).toEqual({ blocked: true });
  expect(await readFile(secret, "utf8")).toBe("secret");
});

it("reads an approved managed environment without granting writes to it", async () => {
  if (!researchSandboxStatus().available) return;
  const workspace = await mkdtemp(join(tmpdir(), "pi-science-sandbox-"));
  cleanup.push(workspace);
  const previousHome = process.env.PI_SCIENCE_HOME;
  process.env.PI_SCIENCE_HOME = join(workspace, "config");
  try {
    const prefix = join(process.env.PI_SCIENCE_HOME, "micromamba", "envs", "rev-test");
    const work = join(metadataRoot(workspace), "runs", "run-test", "work");
    const outputs = join(metadataRoot(workspace), "runs", "run-test", "outputs");
    await mkdir(prefix, { recursive: true }); await mkdir(work, { recursive: true }); await mkdir(outputs);
    await writeFile(join(prefix, "library.txt"), "package-data");
    const windows = process.platform === "win32";
    const script = join(work, windows ? "solve.cjs" : "solve.sh");
    await writeFile(script, windows
      ? `const fs=require('node:fs'); const path=require('node:path'); const source=path.join(process.env.PI_SCIENCE_ENVIRONMENT_PREFIX,'library.txt'); fs.writeFileSync(path.join(process.env.PI_SCIENCE_OUTPUT_DIR,'result.txt'),fs.readFileSync(source)); try { fs.writeFileSync(source,'bad'); } catch {}`
      : 'cat "$PI_SCIENCE_ENVIRONMENT_PREFIX/library.txt" > "$PI_SCIENCE_OUTPUT_DIR/result.txt"\nprintf "bad" > "$PI_SCIENCE_ENVIRONMENT_PREFIX/library.txt"\n');
    const isolated = await sandboxResearchCommand({ command: [windows ? process.execPath : "/bin/bash", script], workspace, executionCwd: work, surface: "research-loop", environment: { PATH: process.env.PATH, PI_SCIENCE_OUTPUT_DIR: outputs, PI_SCIENCE_ENVIRONMENT_PREFIX: prefix }, managedEnvironmentPrefix: prefix });
    spawnSync(isolated.command[0]!, isolated.command.slice(1), { cwd: work, env: isolated.environment, encoding: "utf8" });
    expect(await readFile(join(outputs, "result.txt"), "utf8")).toBe("package-data");
    expect(await readFile(join(prefix, "library.txt"), "utf8")).toBe("package-data");
  } finally {
    if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME;
    else process.env.PI_SCIENCE_HOME = previousHome;
  }
});

it("runs a conversation command with project writes and a read-only managed environment", async () => {
  if (process.platform === "win32" || !researchSandboxStatus().available) return;
  const root = await mkdtemp(join(tmpdir(), "pi-science-conversation-test-"));
  cleanup.push(root);
  const workspace = join(root, "project");
  const home = join(root, "control-home");
  const prefix = join(home, "micromamba", "envs", "rev-test");
  await mkdir(workspace, { recursive: true }); await mkdir(prefix, { recursive: true });
  await writeFile(join(prefix, "library.txt"), "package-data");
  await writeFile(join(root, "host-secret.txt"), "secret");
  const previousHome = process.env.PI_SCIENCE_HOME;
  process.env.PI_SCIENCE_HOME = home;
  try {
    const controlSecret = join(metadataRoot(workspace), "control-secret.txt");
    await mkdir(metadataRoot(workspace), { recursive: true });
    await writeFile(controlSecret, "control-secret");
    const script = 'cat "$PI_SCIENCE_ENVIRONMENT_PREFIX/library.txt" > result.txt; if cat "../host-secret.txt" 2>/dev/null; then echo READ_ESCAPED; fi; if cat "$PI_SCIENCE_CONTROL_SECRET" 2>/dev/null; then echo METADATA_READ; fi; if printf hacked > "$PI_SCIENCE_CONTROL_SECRET" 2>/dev/null; then echo METADATA_WRITE; fi; if printf hacked > "$PI_SCIENCE_ENVIRONMENT_PREFIX/library.txt" 2>/dev/null; then echo WRITE_ESCAPED; fi';
    const isolated = await sandboxConversationCommand({
      command: ["/bin/bash"], conversationScript: script, workspace,
      environment: { PATH: process.env.PATH, PI_SCIENCE_CONTROL_SECRET: controlSecret, PI_SCIENCE_ENVIRONMENT_PREFIX: prefix, PI_SCIENCE_ENVIRONMENT_REVISION_ID: "rev-test" },
      managedEnvironmentPrefix: prefix,
    });
    cleanup.push(isolated.cleanupDirectory);
    const result = spawnSync(isolated.command[0]!, isolated.command.slice(1), { cwd: workspace, env: isolated.environment, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("secret");
    expect(result.stdout).not.toContain("READ_ESCAPED");
    expect(result.stdout).not.toContain("WRITE_ESCAPED");
    expect(result.stdout).not.toContain("METADATA_READ");
    expect(result.stdout).not.toContain("METADATA_WRITE");
    expect(await readFile(join(workspace, "result.txt"), "utf8")).toBe("package-data");
    expect(await readFile(join(prefix, "library.txt"), "utf8")).toBe("package-data");
    expect(await readFile(controlSecret, "utf8")).toBe("control-secret");
  } finally {
    if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME;
    else process.env.PI_SCIENCE_HOME = previousHome;
  }
});

it.skipIf(process.platform !== "win32")("runs a Windows conversation command through the production Sandy path", async () => {
  expect(researchSandboxStatus()).toMatchObject({ available: true, backend: "appcontainer" });
  const root = await mkdtemp(join(tmpdir(), "pi-science-conversation-win-"));
  cleanup.push(root);
  const workspace = join(root, "project");
  const stateHome = join(root, "control-home");
  const prefix = join(stateHome, "micromamba", "envs", "rev-test");
  const previousHome = process.env.PI_SCIENCE_HOME;
  process.env.PI_SCIENCE_HOME = stateHome;
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(prefix, { recursive: true });
    await writeFile(join(prefix, "library.txt"), "package-data", "utf8");
    const controlSecret = join(metadataRoot(workspace), "control-secret.txt");
    await mkdir(metadataRoot(workspace), { recursive: true });
    await writeFile(controlSecret, "control-secret", "utf8");
    const script = join(workspace, "conversation.cjs");
    await writeFile(script, `const fs=require("node:fs"); const path=require("node:path");
      const source=path.join(process.env.PI_SCIENCE_ENVIRONMENT_PREFIX,"library.txt");
      let stateBlocked=false; try { fs.readFileSync(process.env.PI_SCIENCE_CONTROL_SECRET); } catch { stateBlocked=true; }
      try { fs.writeFileSync(source,"hacked"); } catch {}
      fs.writeFileSync(path.join(process.cwd(),"result.json"),JSON.stringify({stateBlocked,value:fs.readFileSync(source,"utf8")}));`, "utf8");
    const isolated = await sandboxConversationCommand({
      command: [process.execPath, script], workspace,
      environment: {
        ...process.env,
        PI_SCIENCE_CONTROL_SECRET: controlSecret,
        PI_SCIENCE_ENVIRONMENT_PREFIX: prefix,
        PI_SCIENCE_ENVIRONMENT_REVISION_ID: "rev-test",
      },
      managedEnvironmentPrefix: prefix,
    });
    cleanup.push(isolated.cleanupDirectory);
    const result = spawnSync(isolated.command[0]!, isolated.command.slice(1), { cwd: workspace, env: isolated.environment, encoding: "utf8", timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(workspace, "result.json"), "utf8"))).toEqual({ stateBlocked: true, value: "package-data" });
    expect(await readFile(controlSecret, "utf8")).toBe("control-secret");
  } finally {
    if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME;
    else process.env.PI_SCIENCE_HOME = previousHome;
  }
});

it("denies outbound connections from a research job", async () => {
  if (!researchSandboxStatus().available) return;
  const server = createServer((socket) => {
    // The unsandboxed control client exits as soon as it connects. Windows can
    // deliver its reset after the test body, so consume that socket error.
    socket.on("error", () => {});
    socket.resume();
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-sandbox-"));
    cleanup.push(workspace);
    const evaluator = join(metadataRoot(workspace), "runs", "run-test", "evaluator");
    await mkdir(evaluator, { recursive: true });
    const port = (server.address() as AddressInfo).port;
    const connect = `const socket=require('node:net').connect(${port}, '127.0.0.1'); socket.on('connect',()=>process.exit(0)); socket.on('error',()=>process.exit(3)); setTimeout(()=>process.exit(4),2000);`;
    expect(spawnSync(process.execPath, ["-e", connect], { encoding: "utf8", timeout: 4_000 }).status).toBe(0);
    const isolated = await sandboxResearchCommand({ command: [process.execPath, "-e", connect], workspace, executionCwd: evaluator, surface: "research-evaluator", environment: { PATH: process.env.PATH, PI_SCIENCE_EVALUATION_PATH: join(evaluator, "evaluation.json") } });
    const result = spawnSync(isolated.command[0]!, isolated.command.slice(1), { cwd: evaluator, env: isolated.environment, encoding: "utf8", timeout: process.platform === "win32" ? 15_000 : 4_000 });
    expect(result.status).not.toBe(0);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
