import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiManager } from "./pi-manager.js";
import { PiProcess, type PiProcessOptions } from "./pi-process.js";

const cleanup: string[] = [];
const managers: PiManager[] = [];
const processes: PiProcess[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdownAll()));
  await Promise.all(processes.splice(0).map((process) => process.shutdown()));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

const READLINE_PRELUDE = [
  'import readline from "node:readline";',
  'const input = readline.createInterface({ input: process.stdin });',
];

function respond(request: string): string {
  return `process.stdout.write(JSON.stringify({ id: ${request}.id, success: true, data: { type: ${request}.type } }) + "\\n");`;
}

/** Answers every request by id and pushes one unsolicited event. `extra` lines
 *  run at module scope, i.e. before the runtime answers its first command. */
function echoBody(extra: string[] = []): string[] {
  return [
    ...READLINE_PRELUDE,
    ...extra,
    'input.on("line", (line) => {',
    '  const request = JSON.parse(line);',
    `  ${respond("request")}`,
    '  process.stdout.write(JSON.stringify({ type: "session.idle", sessionId: "s1" }) + "\\n");',
    '});',
  ];
}

const ECHO_BODY = echoBody();

async function fakeRuntime(body: string[] = ECHO_BODY): Promise<PiProcessOptions & { cwd: string }> {
  const cwd = join(tmpdir(), `pi-science-pi-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(cwd);
  await mkdir(cwd, { recursive: true });
  const script = join(cwd, "fake-pi.mjs");
  await writeFile(script, body.join("\n"), "utf8");
  return { cwd, command: process.execPath, args: [script] };
}

function startRuntime(body: string[]): Promise<PiProcess> {
  return fakeRuntime(body).then((options) => {
    const process = PiProcess.start(options);
    processes.push(process);
    return process;
  });
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met before the timeout");
}

describe("Pi RPC process (stdio JSONL)", () => {
  it("correlates a response with its own request id and emits unsolicited events", async () => {
    const process = await startRuntime(ECHO_BODY);
    const events: string[] = [];
    process.on("event", (event: { type: string }) => events.push(event.type));

    await expect(process.sendCommand("get_state")).resolves.toMatchObject({ success: true, data: { type: "get_state" } });

    await waitFor(() => events.includes("session.idle"));
    expect(events).toContain("session.idle");
  });

  it("matches each response to its own request when replies arrive out of order", async () => {
    // alpha/beta are held and replayed in reverse order, so the reply order
    // cannot be what correlates a response with its pending request.
    const process = await startRuntime([
      ...READLINE_PRELUDE,
      'const held = [];',
      'input.on("line", (line) => {',
      '  const request = JSON.parse(line);',
      '  if (request.type === "alpha" || request.type === "beta") { held.push(request); return; }',
      '  if (request.type === "flush") {',
      '    for (const item of held.splice(0).reverse()) {',
      `      ${respond("item")}`,
      '    }',
      `    ${respond("request")}`,
      '    return;',
      '  }',
      `  ${respond("request")}`,
      '});',
    ]);

    const alpha = process.sendCommand("alpha");
    const beta = process.sendCommand("beta");
    await expect(process.sendCommand("flush")).resolves.toMatchObject({ success: true });

    await expect(alpha).resolves.toMatchObject({ success: true, data: { type: "alpha" } });
    await expect(beta).resolves.toMatchObject({ success: true, data: { type: "beta" } });
  });

  it("surfaces a malformed stdout line without breaking the request stream", async () => {
    const process = await startRuntime([
      ...READLINE_PRELUDE,
      'input.on("line", (line) => {',
      '  const request = JSON.parse(line);',
      '  process.stdout.write("this is not json\\n");',
      `  ${respond("request")}`,
      '});',
    ]);
    const malformed: string[] = [];
    process.on("malformed", (line: string) => malformed.push(line));

    await expect(process.sendCommand("get_state")).resolves.toMatchObject({ success: true, data: { type: "get_state" } });

    expect(malformed).toEqual(["this is not json"]);
    expect(process.isClosed).toBe(false);
  });

  it("fails pending requests when the runtime exits", async () => {
    const process = await startRuntime([
      ...READLINE_PRELUDE,
      'input.on("line", (line) => {',
      '  const request = JSON.parse(line);',
      '  if (request.type === "crash") process.exit(3);',
      '});',
    ]);

    const waiting = process.sendCommand("wait");
    const crash = await process.sendCommand("crash");

    expect(crash).toMatchObject({ success: false, code: "process_exit" });
    expect(String(crash.error)).toContain("exited with code 3");
    await expect(waiting).resolves.toMatchObject({ success: false, code: "process_exit" });
    expect(process.isClosed).toBe(true);
  });

  it("fails a command immediately once the process is closed", async () => {
    const process = await startRuntime(ECHO_BODY);
    await process.shutdown();

    await expect(process.sendCommand("get_state")).resolves.toMatchObject({ success: false, code: "process_closed" });
    await expect(process.sendNotification("extension_ui_response", { id: "q1" })).rejects.toThrow(/stdin is unavailable/);
  });

  it.skipIf(process.platform === "win32")("terminates a responsive runtime with SIGTERM", async () => {
    const process = await startRuntime(ECHO_BODY);
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => process.once("exit", resolve));
    // Wait for the child to boot so the kill observes a loaded runtime.
    await expect(process.sendCommand("ready")).resolves.toMatchObject({ success: true });

    await process.shutdown();

    await expect(exit).resolves.toMatchObject({ signal: "SIGTERM" });
    expect(process.isClosed).toBe(true);
  }, 15_000);

  it.skipIf(process.platform === "win32")("escalates to SIGKILL when the runtime ignores SIGTERM", async () => {
    const process = await startRuntime(echoBody(['process.on("SIGTERM", () => {});', 'setInterval(() => {}, 1_000);']));
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => process.once("exit", resolve));
    // The SIGTERM listener only exists once the module body has run.
    await expect(process.sendCommand("ready")).resolves.toMatchObject({ success: true });

    const started = Date.now();
    await process.shutdown();
    const elapsed = Date.now() - started;

    await expect(exit).resolves.toMatchObject({ signal: "SIGKILL" });
    // SIGTERM was ignored, so the 2s escalation window must have elapsed.
    expect(elapsed).toBeGreaterThanOrEqual(1_800);
  }, 15_000);
});

describe("Pi manager", () => {
  it("correlates commands and emits unsolicited events", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeRuntime();
    const process = await manager.start("workspace", runtime);
    const events: string[] = [];
    process.on("event", (event: { type: string }) => events.push(event.type));

    await expect(manager.sendCommand("workspace", "get_state")).resolves.toMatchObject({ success: true, data: { type: "get_state" } });

    await waitFor(() => events.includes("session.idle"));
    expect(events).toContain("session.idle");
  });

  it("does not start a process for an unknown key", async () => {
    const manager = new PiManager();
    managers.push(manager);

    await expect(manager.sendCommand("missing", "get_state")).resolves.toMatchObject({ success: false, code: "not_found" });
    expect(manager.get("missing")).toBeUndefined();
  });

  it("returns a stable error when the process exits", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeRuntime();
    const process = await manager.start("workspace", runtime);

    await process.shutdown();

    await expect(manager.sendCommand("workspace", "get_state")).resolves.toMatchObject({ code: "not_found" });
  });

  it("starts one runtime process per key instead of sharing a host", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeRuntime();
    const first = await manager.start("workspace-a", runtime);
    const second = await manager.start("workspace-b", runtime);

    expect(first.child.pid).not.toBe(second.child.pid);
    expect(manager.get("workspace-a")).toBe(first);
    expect(manager.activeCount).toBe(2);
    expect(manager.processCount).toBe(2);

    await manager.stop("workspace-a");
    expect(manager.get("workspace-a")).toBeUndefined();
    expect(manager.activeCount).toBe(1);
    await expect(manager.sendCommand("workspace-b", "get_state")).resolves.toMatchObject({ success: true });

    await manager.shutdownAll();
    expect(manager.activeCount).toBe(0);
    expect(manager.processCount).toBe(0);
  });

  it("reuses the process already started for a key", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeRuntime();
    const first = await manager.start("workspace", runtime);
    const second = await manager.start("workspace", runtime);

    expect(second).toBe(first);
    expect(manager.processCount).toBe(1);
  });
});
