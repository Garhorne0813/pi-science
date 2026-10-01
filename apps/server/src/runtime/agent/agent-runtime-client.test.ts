import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCoreRuntimeClient, workerEnvironment } from "./agent-runtime-client.js";
import { SessionRuntime } from "./worker/session-runtime.js";
import { BACKGROUND_CONTEXT, type AgentLane } from "@earendil-works/pi-agent-core/node";

const roots: string[] = [];
const clients: AgentCoreRuntimeClient[] = [];

async function options() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-agent-core-"));
  roots.push(cwd);
  const sessionsRoot = join(cwd, ".pi-science", "agent-sessions");
  await mkdir(sessionsRoot, { recursive: true });
  return { cwd, sessionsRoot, model: { provider: "openai", modelId: "gpt-4.1-mini" }, thinking: "low" as const };
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentCoreRuntimeClient", () => {
  it("passes only declared custom credential variables to a worker", () => {
    const input = { MY_LAB_TOKEN: "test-secret", UNRELATED_SECRET: "do-not-forward" };
    expect(workerEnvironment(input, ["MY_LAB_TOKEN"])).toMatchObject({ MY_LAB_TOKEN: "test-secret" });
    expect(workerEnvironment(input, ["MY_LAB_TOKEN"])).not.toHaveProperty("UNRELATED_SECRET");
  });
  it("creates a durable session in a child process and reopens it", async () => {
    const start = await options();
    const first = await AgentCoreRuntimeClient.start(start, 5_000);
    clients.push(first);
    expect(first.sessionId).toBeTruthy();
    expect(await first.sendCommand("get_state")).toMatchObject({
      success: true,
      data: { sessionId: first.sessionId, busy: false, model: start.model, thinkingLevel: "low",
        activeTools: expect.arrayContaining(["read", "bash", "edit", "write"]) },
    });
    await first.shutdown();

    const second = await AgentCoreRuntimeClient.start({ ...start, sessionId: first.sessionId }, 5_000);
    clients.push(second);
    expect(second.sessionId).toBe(first.sessionId);
    expect((await second.sendCommand("get_state")).success).toBe(true);
  });

  it("isolates a worker crash and reopens its durable session", async () => {
    const start = await options();
    const first = await AgentCoreRuntimeClient.start(start, 5_000);
    clients.push(first);
    const sessionId = first.sessionId;
    const exited = new Promise<void>((resolve) => first.once("exit", () => resolve()));
    first.child.kill("SIGKILL");
    await exited;
    expect(first.isClosed).toBe(true);
    await expect(first.sendCommand("get_state")).rejects.toThrow("closed");

    const recovered = await AgentCoreRuntimeClient.start({ ...start, sessionId }, 5_000);
    clients.push(recovered);
    expect(recovered.sessionId).toBe(sessionId);
    expect((await recovered.sendCommand("get_state")).success).toBe(true);
  });

  it("acknowledges a prompt before the durable run settles", async () => {
    const start = await options();
    const client = await AgentCoreRuntimeClient.start(start, 5_000);
    clients.push(client);
    const events: string[] = [];
    const settled = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("run did not settle")), 5_000);
      client.on("event", (event: { type: string }) => {
        events.push(event.type);
        if (event.type === "agent_settled") { clearTimeout(timer); resolve(); }
      });
    });
    const result = await client.sendCommand("prompt", { message: "Say hello", client_message_id: "browser-123" });
    expect(result).toMatchObject({ success: true, operationId: expect.any(String) });
    expect(await client.sendCommand("prompt", { message: "Say hello", client_message_id: "browser-123" }))
      .toMatchObject({ success: true, operationId: result.operationId, deduplicated: true });
    expect(await client.sendCommand("prompt", { message: "Changed payload", client_message_id: "browser-123" }))
      .toMatchObject({ success: false, code: "client_message_id_conflict" });
    // No credential is provided; the run fails after admission, through the event stream.
    await settled;
    expect(events).toContain("agent_start");
    expect((await client.sendCommand("get_state")).data).toMatchObject({ busy: false });
    expect(await client.sendCommand("get_messages")).toMatchObject({
      success: true,
      data: { messages: expect.arrayContaining([expect.objectContaining({ message: expect.objectContaining({ client_message_id: "browser-123" }) })]) },
    });
    await client.shutdown();
    const reopened = await AgentCoreRuntimeClient.start({ ...start, sessionId: client.sessionId }, 5_000);
    clients.push(reopened);
    expect(await reopened.sendCommand("prompt", { message: "Say hello", client_message_id: "browser-123" }))
      .toMatchObject({ success: true, operationId: result.operationId, deduplicated: true });
    expect(await reopened.sendCommand("get_messages")).toMatchObject({
      success: true,
      data: { messages: expect.arrayContaining([expect.objectContaining({ message: expect.objectContaining({ client_message_id: "browser-123" }) })]) },
    });
    const history = (await reopened.sendCommand("get_messages")).data as { messages: Array<{ message: { client_message_id?: string } }> };
    expect(history.messages.filter((entry) => entry.message.client_message_id === "browser-123")).toHaveLength(1);
  });

  it("keeps a recovered operation paused until the consumer binds and activates", async () => {
    const start = await options();
    const fixture = await SessionRuntime.open(start, () => undefined, (error) => { throw error; });
    let sessionId: string;
    try {
      const lane = (fixture as unknown as { lane: AgentLane }).lane;
      expect((await lane.accept({ kind: "prompt", prompt: "recover this accepted operation" }, BACKGROUND_CONTEXT)).ok).toBe(true);
      sessionId = fixture.sessionId;
    } finally { await fixture.close(); }
    const recovered = await AgentCoreRuntimeClient.start({ ...start, sessionId, deferActivation: true }, 5_000);
    clients.push(recovered);
    const events: Array<{ type: string; recovery?: boolean }> = [];
    recovered.on("event", (event) => events.push(event));
    expect(await recovered.sendCommand("get_state")).toMatchObject({ success: true, data: { busy: true } });
    expect(events).toEqual([]);
    expect(await recovered.sendCommand("activate")).toMatchObject({ success: true });
    await vi.waitFor(() => expect(events.some((event) => event.type === "agent_settled")).toBe(true), { timeout: 5_000 });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "agent_start", recovery: true })]));
    expect(await recovered.sendCommand("get_state")).toMatchObject({ success: true, data: { busy: false } });
  }, 20_000);

  it("forks a durable branch while the source worker remains open", async () => {
    const start = await options();
    const source = await AgentCoreRuntimeClient.start(start, 5_000);
    clients.push(source);
    const fork = await source.sendCommand("fork");
    expect(fork).toMatchObject({ success: true, sessionId: expect.any(String) });
    expect(fork.sessionId).not.toBe(source.sessionId);
    const child = await AgentCoreRuntimeClient.start({ ...start, sessionId: String(fork.sessionId) }, 5_000);
    clients.push(child);
    expect(child.sessionId).toBe(fork.sessionId);
    const clone = await source.sendCommand("clone");
    expect(clone).toMatchObject({ success: true, sessionId: expect.any(String) });
    expect(clone.sessionId).not.toBe(source.sessionId);
    expect(clone.sessionId).not.toBe(child.sessionId);
    expect((await source.sendCommand("get_state")).success).toBe(true);
  });

  it("loads workspace skills and applies the policy without restarting the worker", async () => {
    const start = await options();
    const directory = join(start.cwd, ".pi", "skills", "lab-method");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "---\nname: lab-method\ndescription: Analyze lab data\n---\n# Lab method\nFollow the measurements.\n");
    const client = await AgentCoreRuntimeClient.start(start, 5_000);
    clients.push(client);
    expect(await client.getSkills()).toMatchObject({ success: true, data: { skills: [expect.objectContaining({ name: "lab-method", enabled: true })] } });
    expect(await client.setSkillPolicy({ mode: "none" })).toMatchObject({ success: true });
    expect(await client.getSkills()).toMatchObject({ success: true, data: { skills: [expect.objectContaining({ name: "lab-method", enabled: false })] } });
    expect(await client.setSkillPolicy({ mode: "allowlist", skills: ["lab-method"] })).toMatchObject({ success: true });
    expect(await client.getSkills()).toMatchObject({ success: true, data: { skills: [expect.objectContaining({ name: "lab-method", enabled: true })] } });
  });
});
