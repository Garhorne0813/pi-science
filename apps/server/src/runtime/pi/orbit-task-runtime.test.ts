import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { PiProcess } from "./pi-process.js";
import { OrbitTaskRuntime } from "./orbit-task-runtime.js";

function setup() {
  const process = Object.assign(new EventEmitter(), { sendCommand: vi.fn(async () => ({ success: true })) });
  const runtime = new OrbitTaskRuntime(process as unknown as PiProcess);
  const request = { message: "review", clientMessageId: "stable", deadline: Date.now() + 10_000 };
  return { process, runtime, request };
}
function expectDetached(process: EventEmitter) {
  expect(process.listenerCount("event")).toBe(0);
  expect(process.listenerCount("exit")).toBe(0);
}
describe("legacy task stream boundary", () => {
  it("captures results and usage that arrive before admission acknowledgement", async () => {
    const { process, runtime, request } = setup();
    const onUsage = vi.fn();
    process.sendCommand.mockImplementation(async () => {
      process.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "[]" } });
      process.emit("event", { type: "message_end", message: { usage: { input: 10, output: 2, cost: { total: 0.25 } } } });
      process.emit("event", { type: "agent_settled" });
      return { success: true };
    });
    expect(await runtime.prompt({ ...request, onUsage })).toBe("[]");
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ model_tokens: 12, cost_usd: 0.25 });
    expectDetached(process);
  });
  it("rejects denied admission even if a settled event arrived first", async () => {
    const { process, runtime, request } = setup();
    process.sendCommand.mockImplementation(async () => {
      process.emit("event", { type: "agent_settled" });
      return { success: false, error: "denied" };
    });
    await expect(runtime.prompt(request)).rejects.toThrow("denied");
    expectDetached(process);
  });
  it("enforces the deadline while admission remains unresolved", async () => {
    const { process, runtime, request } = setup();
    process.sendCommand.mockImplementation(() => new Promise(() => {}));
    await expect(runtime.prompt({ ...request, deadline: Date.now() + 10 })).rejects.toThrow("timed out");
    expectDetached(process);
  });
  it("retains spend and releases listeners when the process exits", async () => {
    const { process, runtime, request } = setup();
    const onUsage = vi.fn();
    const result = runtime.prompt({ ...request, onUsage });
    process.emit("event", { type: "message_end", message: { usage: { input: 5, output: 1 } } });
    process.emit("exit");
    await expect(result).rejects.toThrow("exited");
    expect(onUsage).toHaveBeenCalledWith({ model_tokens: 6, cost_usd: 0 });
    expectDetached(process);
  });
});
