import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AgentCoreRuntimeClient } from "./agent-runtime-client.js";
import { ApprovalBridge } from "./worker/approval-bridge.js";
import { workerRequestSchema } from "./worker/protocol.js";

function worker() {
  const child = new EventEmitter();
  const messages: Array<{ type: string }> = [];
  let bridge: ApprovalBridge;
  Object.assign(child, { connected: true, send: (raw: unknown, done: (error?: Error) => void) => {
    const message = workerRequestSchema.parse(raw);
    messages.push(message);
    if (message.type === "approval_granted") bridge.grant(message.id);
    done();
  } });
  const client = Reflect.construct(AgentCoreRuntimeClient, [child, "/workspace", 1000]) as AgentCoreRuntimeClient;
  bridge = new ApprovalBridge(event => child.emit("message", event));
  return { bridge, messages, exit: () => child.emit("exit", 0, null), client };
}

describe("control-plane approval IPC", () => {
  it("coordinates separate workers and reclaims an exited owner's lease", async () => {
    const first = worker(), second = worker();
    try {
      await first.bridge.acquire("ipc-shared-target");
      const entered = vi.fn();
      const waiting = second.bridge.acquire("ipc-shared-target").then(release => { entered(); return release; });
      await Promise.resolve();
      expect(entered).not.toHaveBeenCalled(); expect(second.messages).toHaveLength(0);
      first.exit();
      const release = await waiting;
      expect(second.messages).toMatchObject([{ type: "approval_granted" }]);
      release();
      (await second.bridge.acquire("ipc-shared-target"))();
    } finally { first.exit(); second.exit(); }
  });

  it("does not release an admitted operation until its persistence scope exits", async () => {
    const first = worker(), second = worker(), abort = new AbortController();
    try {
      const release = await first.bridge.acquire("ipc-saving-target", abort.signal);
      const entered = vi.fn();
      const waiting = second.bridge.acquire("ipc-saving-target").then(leave => { entered(); return leave; });
      abort.abort(); await Promise.resolve();
      expect(entered).not.toHaveBeenCalled();
      release(); (await waiting)();
    } finally { first.exit(); second.exit(); }
  });

  it("cancels a waiting worker without admitting it or blocking its successor", async () => {
    const first = worker(), second = worker(), abort = new AbortController();
    try {
      const release = await first.bridge.acquire("ipc-cancel-target");
      const waiting = second.bridge.acquire("ipc-cancel-target", abort.signal);
      const failure = expect(waiting).rejects.toThrow("cancelled");
      abort.abort(new Error("cancelled")); await failure;
      release();
      (await second.bridge.acquire("ipc-cancel-target"))();
      expect(second.messages).toHaveLength(1);
    } finally { first.exit(); second.exit(); }
  });
});
