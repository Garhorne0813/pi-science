import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { AgentCoreRuntimeClient } from "../agent-runtime-client.js";
import { decodeCommand, decodeNotification, validResultData } from "./command-contract.js";
import { workerEventSchema, workerRequestSchema } from "./protocol.js";

function connection() {
  const child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn((_message: unknown, callback: (error?: Error) => void) => callback()) });
  const client = Reflect.construct(AgentCoreRuntimeClient, [child as unknown as ChildProcess, "/workspace", 100]) as AgentCoreRuntimeClient;
  return { child, client };
}
describe("worker contract validation", () => {
  it("rejects invalid command and notification bodies without returning their contents", () => {
    expect(decodeCommand("prompt", { message: " ", client_message_id: "secret-value" })).toMatchObject({ ok: false, result: { code: "invalid_message" } });
    expect(JSON.stringify(decodeCommand("configure", { provider: "p", modelId: "m", apiKey: "secret-value" }))).not.toContain("secret-value");
    expect(decodeCommand("unknown", {})).toMatchObject({ ok: false, result: { code: "unsupported_command" } });
    expect(decodeNotification("subagent_response", { id: "x", result: { success: "yes" } })).toMatchObject({ ok: false });
    expect(workerRequestSchema.safeParse({ type: "command", command: "abort", params: {} }).success).toBe(false);
  });
  it("rejects unknown events and malformed authoritative snapshots", () => {
    expect(workerEventSchema.safeParse({ type: "runtime_event", event: { type: "agent_settled" } }).success).toBe(false);
    expect(workerEventSchema.safeParse({ type: "runtime_event", event: { type: "operation.settled", runId: "r", status: "possibly" } }).success).toBe(false);
    expect(validResultData("get_state", { success: true, data: { busy: false } })).toBe(false);
    expect(validResultData("get_state", { success: false, code: "busy" })).toBe(true);
  });
  it("fails a correlated malformed response immediately and ignores its later duplicate", async () => {
    const { child, client } = connection();
    const malformed = vi.fn(); client.on("malformed", malformed);
    const result = client.sendCommand("get_state");
    const request = child.send.mock.calls[0]![0] as { requestId: string };
    child.emit("message", { type: "result", requestId: request.requestId, result: { success: true, data: { busy: false, credential: "secret-value" } } });
    await expect(result).rejects.toThrow("invalid agent worker result for get_state");
    expect(malformed).toHaveBeenCalledExactlyOnceWith("invalid result for get_state");
    child.emit("message", { type: "result", requestId: request.requestId, result: { success: true } });
    expect(malformed).toHaveBeenCalledTimes(1);
  });
  it("rejects pending requests on exit and admits no command after closure", async () => {
    const { child, client } = connection();
    const result = client.sendCommand("abort");
    child.emit("exit", 1, null);
    await expect(result).rejects.toThrow("exited");
    await expect(client.sendCommand("abort")).rejects.toThrow("closed");
    expect(child.send).toHaveBeenCalledTimes(1);
  });
});
