import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiManager } from "./pi-manager.js";

const managers: PiManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdownAll()));
});

async function fakeRuntime(): Promise<{ cwd: string; command: string; args: string[] }> {
  const cwd = join(tmpdir(), `pi-science-pi-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(cwd, { recursive: true });
  const script = join(cwd, "fake-pi.mjs");
  await writeFile(script, [
    'import readline from "node:readline";',
    'const input = readline.createInterface({ input: process.stdin });',
    'input.on("line", (line) => {',
    '  const request = JSON.parse(line);',
    '  process.stdout.write(JSON.stringify({ id: request.id, success: true, data: { type: request.type } }) + "\\n");',
    '  process.stdout.write(JSON.stringify({ type: "session.idle", sessionId: "s1" }) + "\\n");',
    '});',
  ].join("\n"), "utf8");
  return { cwd, command: process.execPath, args: [script] };
}

describe("Node Pi JSONL adapter", () => {
  it("correlates commands and emits unsolicited events", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeRuntime();
    const process = manager.start("workspace", runtime);
    const events: string[] = [];
    process.on("event", (event: { type: string }) => events.push(event.type));
    await expect(manager.sendCommand("workspace", "get_state")).resolves.toMatchObject({ success: true, data: { type: "get_state" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toContain("session.idle");
    await rm(runtime.cwd, { recursive: true, force: true });
  });

  it("returns a stable error when the process exits", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeRuntime();
    const process = manager.start("workspace", runtime);
    await process.shutdown();
    await expect(manager.sendCommand("workspace", "get_state")).resolves.toMatchObject({ code: "not_found" });
    await rm(runtime.cwd, { recursive: true, force: true });
  });
});
